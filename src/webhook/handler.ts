import { Request, Response, Router } from 'express';
import { getConfig } from '../config';
import { isEventProcessed, markEventProcessed, recordSourceTrade, updateSourceTradeAction, getVirtualPnL, recordPnlSnapshot } from '../db/repo';
import { evaluateRisk } from '../risk/engine';
import { executeSwap } from '../trade/jupiter';
import { updatePosition } from '../trade/position';
import { getSharedConnection } from '../trade/solana';
import { parseSwapFromRpc } from '../monitor/wsMonitor';
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
    'Transaction involving source wallet detected (webhook)',
  );

  // Use RPC pre/post balances for accurate parsing
  // (Helius nativeTransfers can be incomplete for Pump.fun)
  const connection = getSharedConnection();
  const parsed = await parseSwapFromRpc(connection, tx.signature, sourceWallet);

  if (!parsed) {
    markEventProcessed(tx.signature);
    logger.info({ sig: tx.signature, type: tx.type, source: tx.source }, 'Not a parseable swap (RPC check)');
    return;
  }

  logger.info(
    { direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig: parsed.signature },
    'Source wallet swap detected (webhook+RPC)',
  );

  await handleParsedSwap(parsed);
}

/**
 * Shared post-parsing pipeline: record → risk → execute.
 * Called by both the webhook handler and the WebSocket monitor.
 */
export async function handleParsedSwap(parsed: ParsedSwap): Promise<void> {
  if (isEventProcessed(parsed.signature)) return;

  markEventProcessed(parsed.signature);

  recordSourceTrade(
    parsed.signature,
    parsed.direction,
    parsed.tokenMint,
    parsed.solAmount,
    parsed.tokenAmount.toString(),
  );

  const riskResult = await evaluateRisk(parsed);

  if (riskResult.action === 'REJECT') {
    updateSourceTradeAction(parsed.signature, 'REJECTED', 0, riskResult.reason);
    logger.warn({ reason: riskResult.reason, sig: parsed.signature }, 'Trade rejected');
    notifyTradeRejected(parsed, riskResult.reason ?? 'Unknown');
    return;
  }

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

    try {
      const cfg = getConfig();
      const pnl = getVirtualPnL();
      recordPnlSnapshot(cfg.VIRTUAL_STARTING_BALANCE + pnl.pnl, pnl.pnl);
    } catch { /* non-critical */ }
  } else {
    updateSourceTradeAction(parsed.signature, 'FAILED', 0, result.error);
    logger.error({ error: result.error, dir: plan.direction, mint: plan.mint }, 'Trade failed');
    notifyError(`Trade failed for ${plan.mint}: ${result.error}`);
  }
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
