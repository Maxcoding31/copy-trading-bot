import { Request, Response, Router } from 'express';
import { getConfig, SOL_MINT, lamportsToSol } from '../config';
import { isEventProcessed, markEventProcessed, recordSourceTrade, updateSourceTradeAction } from '../db/repo';
import { evaluateRisk } from '../risk/engine';
import { executeSwap } from '../trade/jupiter';
import { updatePosition } from '../trade/position';
import { notifyTradeExecuted, notifyTradeRejected, notifyError } from '../notify/telegram';
import { logger } from '../utils/logger';

// ── Helius Enhanced transaction types ──────────────

interface TokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

interface NativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number;
}

interface HeliusEnhancedTx {
  signature: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  timestamp: number;
  description: string;
  nativeTransfers?: NativeTransfer[];
  tokenTransfers?: TokenTransfer[];
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
      tokenOutputs?: Array<{
        userAccount: string;
        tokenAccount: string;
        mint: string;
        rawTokenAmount: { tokenAmount: string; decimals: number };
      }>;
    };
  };
}

export interface ParsedSwap {
  signature: string;
  direction: 'BUY' | 'SELL';
  tokenMint: string;
  /** SOL amount the source spent (BUY) or received (SELL) */
  solAmount: number;
  /** Token amount the source received (BUY) or sent (SELL) */
  tokenAmount: bigint;
  tokenDecimals: number;
}

export const webhookRouter = Router();

webhookRouter.post('/helius', async (req: Request, res: Response) => {
  res.status(200).json({ ok: true });

  const payload: HeliusEnhancedTx[] = Array.isArray(req.body) ? req.body : [req.body];
  const config = getConfig();

  logger.info(
    { count: payload.length, types: payload.map((t) => t.type), feePayers: payload.map((t) => t.feePayer) },
    'Webhook received',
  );

  for (const tx of payload) {
    try {
      await processTx(tx, config.SOURCE_WALLET);
    } catch (err) {
      logger.error({ err, signature: tx?.signature }, 'Error processing webhook event');
      notifyError(`Webhook error: ${(err as Error).message}`);
    }
  }
});

async function processTx(tx: HeliusEnhancedTx, sourceWallet: string): Promise<void> {
  if (isEventProcessed(tx.signature)) {
    return;
  }

  // Check if the source wallet is involved in this transaction
  // (as feePayer, or in any transfer). This supports platforms like
  // Terminal Padre where the feePayer is a relayer, not the user.
  const walletInvolved = isWalletInvolved(tx, sourceWallet);

  if (!walletInvolved) {
    logger.info(
      { type: tx.type, feePayer: tx.feePayer, sig: tx.signature },
      'Wallet not involved in this tx, skipping',
    );
    return;
  }

  logger.info(
    { type: tx.type, feePayer: tx.feePayer, sig: tx.signature, source: tx.source },
    'Transaction involving source wallet detected',
  );

  // Try to parse as a swap (works for SWAP type and also for
  // transfers that are actually swaps routed through aggregators)
  const parsed = parseSwap(tx, sourceWallet);
  if (!parsed) {
    markEventProcessed(tx.signature);
    logger.info(
      {
        sig: tx.signature,
        type: tx.type,
        source: tx.source,
        nativeTransfers: (tx.nativeTransfers ?? []).map((t) => ({
          from: t.fromUserAccount,
          to: t.toUserAccount,
          amount: t.amount,
        })),
        tokenTransfers: (tx.tokenTransfers ?? []).map((t) => ({
          from: t.fromUserAccount,
          to: t.toUserAccount,
          mint: t.mint,
          amount: t.tokenAmount,
        })),
        hasSwapEvent: !!tx.events?.swap,
        description: tx.description?.slice(0, 200),
      },
      'Not a parseable swap – raw data dump',
    );
    return;
  }

  logger.info(
    { direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig: parsed.signature },
    'Source wallet swap detected',
  );

  markEventProcessed(tx.signature);

  recordSourceTrade(
    parsed.signature,
    parsed.direction,
    parsed.tokenMint,
    parsed.solAmount,
    parsed.tokenAmount.toString(),
  );

  // Risk evaluation (includes Jupiter quote)
  const riskResult = await evaluateRisk(parsed);

  if (riskResult.action === 'REJECT') {
    updateSourceTradeAction(parsed.signature, 'REJECTED', 0, riskResult.reason);
    logger.warn({ reason: riskResult.reason, sig: parsed.signature }, 'Trade rejected');
    notifyTradeRejected(parsed, riskResult.reason ?? 'Unknown');
    return;
  }

  // Execute swap using the pre-validated quote from risk engine
  const plan = riskResult.tradePlan!;
  const result = await executeSwap(plan);

  if (result.success) {
    const botSol = plan.direction === 'BUY'
      ? Number(plan.amountRaw) / 1e9
      : Number(plan.quote.outAmount) / 1e9;
    updateSourceTradeAction(parsed.signature, 'COPIED', botSol);
    updatePosition(plan, result.quoteOutAmount ?? plan.quote.outAmount);
    notifyTradeExecuted(parsed, plan, result.txSignature);
    logger.info({ sig: result.txSignature, dir: plan.direction, mint: plan.mint }, 'Trade executed');
  } else {
    updateSourceTradeAction(parsed.signature, 'FAILED', 0, result.error);
    logger.error({ error: result.error, dir: plan.direction, mint: plan.mint }, 'Trade failed');
    notifyError(`Trade failed for ${plan.mint}: ${result.error}`);
  }
}

// ── Swap parsing ───────────────────────────────────

function parseSwap(tx: HeliusEnhancedTx, sourceWallet: string): ParsedSwap | null {
  const swap = tx.events?.swap;
  if (!swap) return parseSwapFallback(tx, sourceWallet);

  const nativeIn = swap.nativeInput;
  const nativeOut = swap.nativeOutput;
  const tokenInputs = swap.tokenInputs ?? [];
  const tokenOutputs = swap.tokenOutputs ?? [];

  // BUY: SOL in → token out
  if (nativeIn && BigInt(nativeIn.amount) > 0n && tokenOutputs.length > 0) {
    const tok = tokenOutputs[0];
    return {
      signature: tx.signature,
      direction: 'BUY',
      tokenMint: tok.mint,
      solAmount: lamportsToSol(BigInt(nativeIn.amount)),
      tokenAmount: BigInt(tok.rawTokenAmount.tokenAmount),
      tokenDecimals: tok.rawTokenAmount.decimals,
    };
  }

  // SELL: token in → SOL out
  if (nativeOut && BigInt(nativeOut.amount) > 0n && tokenInputs.length > 0) {
    const tok = tokenInputs[0];
    return {
      signature: tx.signature,
      direction: 'SELL',
      tokenMint: tok.mint,
      solAmount: lamportsToSol(BigInt(nativeOut.amount)),
      tokenAmount: BigInt(tok.rawTokenAmount.tokenAmount),
      tokenDecimals: tok.rawTokenAmount.decimals,
    };
  }

  return null;
}

/**
 * Check if the source wallet is involved in the transaction in any way:
 * feePayer, token transfers, native transfers, or swap events.
 */
function isWalletInvolved(tx: HeliusEnhancedTx, wallet: string): boolean {
  if (tx.feePayer === wallet) return true;

  const natives = tx.nativeTransfers ?? [];
  if (natives.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet)) return true;

  const tokens = tx.tokenTransfers ?? [];
  if (tokens.some((t) => t.fromUserAccount === wallet || t.toUserAccount === wallet)) return true;

  const swap = tx.events?.swap;
  if (swap) {
    const inputs = swap.tokenInputs ?? [];
    const outputs = swap.tokenOutputs ?? [];
    if (inputs.some((t) => t.userAccount === wallet)) return true;
    if (outputs.some((t) => t.userAccount === wallet)) return true;
    if (swap.nativeInput?.account === wallet) return true;
    if (swap.nativeOutput?.account === wallet) return true;
  }

  if (tx.description?.includes(wallet)) return true;

  return false;
}

function parseSwapFallback(tx: HeliusEnhancedTx, sourceWallet: string): ParsedSwap | null {
  const nativeTransfers = tx.nativeTransfers ?? [];
  const tokenTransfers = tx.tokenTransfers ?? [];

  const solIn = nativeTransfers
    .filter((t) => t.toUserAccount === sourceWallet)
    .reduce((sum, t) => sum + t.amount, 0);

  const solOut = nativeTransfers
    .filter((t) => t.fromUserAccount === sourceWallet)
    .reduce((sum, t) => sum + t.amount, 0);

  const netSol = solIn - solOut;
  const tokens = tokenTransfers.filter((t) => t.mint !== SOL_MINT);

  if (tokens.length === 0 || netSol === 0) return null;

  const tkn = tokens[0];
  const direction: 'BUY' | 'SELL' = netSol > 0 ? 'SELL' : 'BUY';

  return {
    signature: tx.signature,
    direction,
    tokenMint: tkn.mint,
    solAmount: lamportsToSol(Math.abs(netSol)),
    tokenAmount: BigInt(Math.round(tkn.tokenAmount * 1e6)),
    tokenDecimals: 6,
  };
}
