import { Request, Response, Router } from 'express';
import { getConfig, lamportsToSol, SOL_MINT } from '../config';
import { isEventProcessed, markEventProcessed, recordSourceTrade, updateSourceTradeAction, getVirtualPnL, getVirtualCash, recordPnlSnapshot, recordPipelineMetric, getPosition } from '../db/repo';
import { evaluateRisk } from '../risk/engine';
import { executeSwap } from '../trade/jupiter';
import { updatePosition } from '../trade/position';
import { getSharedConnection } from '../trade/solana';
import { parseSwapFromRpc } from '../monitor/wsMonitor';
import { notifyTradeExecuted, notifyTradeRejected, notifyError } from '../notify/telegram';
import { recordOutcome } from '../guard/circuitBreaker';
import { logger } from '../utils/logger';

// ── Known intermediate/stable tokens to exclude from "best token" selection ──
// These can appear in multi-hop swaps (SOL → USDC → MEMECOIN) and should
// never be selected as the canonical swap token.
const INTERMEDIATE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // SOL / WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
]);

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
  /** Detection source for instrumentation */
  _source?: 'webhook' | 'webhook-rpc' | 'ws' | 'poll';
  /**
   * A2: True when parsing used the low-confidence nativeTransfers fallback.
   * Decimals are approximated (6). Trade proceeds but is flagged in metrics.
   */
  _unsafe_parse?: boolean;
}

// ── Async mutex for trade pipeline serialization ──
let _mutexChain: Promise<void> = Promise.resolve();

function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const result = _mutexChain.then(fn, fn);
  // Update chain — swallow errors so the chain never rejects
  _mutexChain = result.then(() => {}, () => {});
  return result;
}

// ── Pending buys tracker (Fix A: sell-before-buy) ──
// Tracks mints that have a BUY detected but not yet fully processed.
// Registered at detection time (BEFORE mutex) so SELLs can see them.
const _pendingBuys = new Set<string>();

export function hasPendingBuy(mint: string): boolean {
  return _pendingBuys.has(mint);
}

/** Register a pending buy at detection time (before entering the mutex). */
export function registerPendingBuy(mint: string): void {
  _pendingBuys.add(mint);
}

/** Clear a pending buy after the BUY is fully processed. */
export function clearPendingBuy(mint: string): void {
  _pendingBuys.delete(mint);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  // P1 FIX: Try parsing directly from Helius enhanced data first (saves 500ms-2s)
  let parsed = parseSwapFromHelius(tx, sourceWallet);

  if (parsed) {
    parsed._source = 'webhook';
    logger.info(
      { direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig: parsed.signature },
      'Source wallet swap detected (Helius direct parse)',
    );
  } else {
    // Fallback to RPC parsing (for edge cases like Pump.fun)
    logger.info({ sig: tx.signature }, 'Helius parse failed, falling back to RPC');
    const connection = getSharedConnection();
    parsed = await parseSwapFromRpc(connection, tx.signature, sourceWallet);

    if (!parsed) {
      markEventProcessed(tx.signature);
      logger.info({ sig: tx.signature, type: tx.type, source: tx.source }, 'Not a parseable swap (RPC check)');
      return;
    }

    parsed._source = 'webhook-rpc';
    logger.info(
      { direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig: parsed.signature },
      'Source wallet swap detected (webhook+RPC fallback)',
    );
  }

  // Register pending buy BEFORE entering the mutex (Fix A: sell-before-buy)
  if (parsed.direction === 'BUY') {
    registerPendingBuy(parsed.tokenMint);
  }

  await handleParsedSwap(parsed);
}

/**
 * P1 FIX: Parse swap directly from Helius enhanced transaction data.
 * Uses events.swap (preferred) or nativeTransfers + tokenTransfers as fallback.
 */
function parseSwapFromHelius(tx: HeliusEnhancedTx, sourceWallet: string): ParsedSwap | null {
  const swap = tx.events?.swap;

  if (swap) {
    return parseFromSwapEvent(tx.signature, swap, sourceWallet);
  }

  // Fallback: reconstruct from nativeTransfers + tokenTransfers
  return parseFromTransfers(tx, sourceWallet);
}

function parseFromSwapEvent(
  signature: string,
  swap: NonNullable<HeliusEnhancedTx['events']>['swap'],
  sourceWallet: string,
): ParsedSwap | null {
  if (!swap) return null;

  const nativeIn = swap.nativeInput;
  const nativeOut = swap.nativeOutput;
  const tokenIns = swap.tokenInputs ?? [];
  const tokenOuts = swap.tokenOutputs ?? [];

  // BUY: source sends SOL (nativeInput) and receives tokens (tokenOutputs)
  if (nativeIn && nativeIn.account === sourceWallet && tokenOuts.length > 0) {
    // Select the best non-intermediate token by largest rawTokenAmount
    // (consistent with RPC parser's "largest delta" logic)
    const tokenOut = selectBestToken(
      tokenOuts.filter((t) => t.userAccount === sourceWallet),
    );
    if (!tokenOut) return null;

    const solAmount = lamportsToSol(Number(nativeIn.amount));
    if (solAmount < 0.00005) return null;

    return {
      signature,
      direction: 'BUY',
      tokenMint: tokenOut.mint,
      solAmount,
      tokenAmount: BigInt(tokenOut.rawTokenAmount.tokenAmount),
      tokenDecimals: tokenOut.rawTokenAmount.decimals,
    };
  }

  // SELL: source sends tokens (tokenInputs) and receives SOL (nativeOutput)
  if (nativeOut && nativeOut.account === sourceWallet && tokenIns.length > 0) {
    const tokenIn = selectBestToken(
      tokenIns.filter((t) => t.userAccount === sourceWallet),
    );
    if (!tokenIn) return null;

    const solAmount = lamportsToSol(Number(nativeOut.amount));
    if (solAmount < 0.00005) return null;

    return {
      signature,
      direction: 'SELL',
      tokenMint: tokenIn.mint,
      solAmount,
      tokenAmount: BigInt(tokenIn.rawTokenAmount.tokenAmount),
      tokenDecimals: tokenIn.rawTokenAmount.decimals,
    };
  }

  return null;
}

/**
 * Select the best (canonical) token from a list of swap event tokens.
 * Strategy: exclude intermediate/stable mints, then pick the one
 * with the largest rawTokenAmount (consistent with RPC parser logic).
 */
function selectBestToken(
  tokens: Array<{
    userAccount: string;
    tokenAccount: string;
    mint: string;
    rawTokenAmount: { tokenAmount: string; decimals: number };
  }>,
): (typeof tokens)[number] | null {
  // First pass: exclude intermediates
  const candidates = tokens.filter((t) => !INTERMEDIATE_MINTS.has(t.mint));

  // If all tokens are intermediates, fall back to non-SOL tokens
  const pool = candidates.length > 0
    ? candidates
    : tokens.filter((t) => t.mint !== SOL_MINT);

  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  // Pick by largest rawTokenAmount
  let best = pool[0];
  let bestAmount = BigInt(best.rawTokenAmount.tokenAmount);
  for (let i = 1; i < pool.length; i++) {
    const amt = BigInt(pool[i].rawTokenAmount.tokenAmount);
    if (amt > bestAmount) {
      bestAmount = amt;
      best = pool[i];
    }
  }

  if (pool.length > 1) {
    logger.info(
      { selected: best.mint, candidates: pool.map((t) => t.mint) },
      '[TOKEN-IDENTITY] Multiple non-intermediate tokens in swap event, selected by largest amount',
    );
  }

  return best;
}

function parseFromTransfers(tx: HeliusEnhancedTx, sourceWallet: string): ParsedSwap | null {
  const natives = tx.nativeTransfers ?? [];
  const tokens = tx.tokenTransfers ?? [];

  if (tokens.length === 0) return null;

  // Calculate net SOL change for source wallet
  let netSolLamports = 0;
  for (const nt of natives) {
    if (nt.fromUserAccount === sourceWallet) netSolLamports -= nt.amount;
    if (nt.toUserAccount === sourceWallet) netSolLamports += nt.amount;
  }

  if (Math.abs(netSolLamports) < 50_000) return null; // noise filter

  // Find the best non-intermediate token transfer involving source wallet.
  // Prefer non-intermediate tokens, then select by largest tokenAmount.
  const relevantTransfers = tokens.filter((tt) => {
    if (INTERMEDIATE_MINTS.has(tt.mint)) return false;
    return tt.fromUserAccount === sourceWallet || tt.toUserAccount === sourceWallet;
  });

  // Fallback: if all relevant transfers were intermediate, try non-SOL
  const pool = relevantTransfers.length > 0
    ? relevantTransfers
    : tokens.filter((tt) => {
        if (tt.mint === SOL_MINT) return false;
        return tt.fromUserAccount === sourceWallet || tt.toUserAccount === sourceWallet;
      });

  if (pool.length === 0) return null;

  // Select by largest tokenAmount
  let bestTransfer = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].tokenAmount > bestTransfer.tokenAmount) {
      bestTransfer = pool[i];
    }
  }

  if (pool.length > 1) {
    logger.info(
      { selected: bestTransfer.mint, candidates: pool.map((t) => t.mint) },
      '[TOKEN-IDENTITY] Multiple token transfers, selected by largest amount',
    );
  }

  const direction: 'BUY' | 'SELL' = bestTransfer.toUserAccount === sourceWallet ? 'BUY' : 'SELL';

  // Cross-validate: BUY should spend SOL (negative), SELL should receive SOL (positive)
  if (direction === 'BUY' && netSolLamports > 0) return null;
  if (direction === 'SELL' && netSolLamports < 0) return null;

  // tokenAmount from Helius is a UI number (float). We reconstruct raw amount.
  // Use 6 decimals as default (Pump.fun standard) — this is an approximation
  // since tokenTransfers doesn't reliably include decimals.
  const decimals = 6;
  const rawTokenAmount = BigInt(Math.round(bestTransfer.tokenAmount * Math.pow(10, decimals)));

  return {
    signature: tx.signature,
    direction,
    tokenMint: bestTransfer.mint,
    solAmount: lamportsToSol(Math.abs(netSolLamports)),
    tokenAmount: rawTokenAmount,
    tokenDecimals: decimals,
    _unsafe_parse: true, // A2: decimals approximated — less reliable
  };
}

/**
 * Shared post-parsing pipeline: record → risk → execute.
 * Called by both the webhook handler and the WebSocket monitor.
 *
 * P5: Serialized via mutex to prevent race conditions on risk checks.
 * Fix A: SELLs with no position but a pending BUY wait OUTSIDE the mutex
 *        so the BUY can proceed and create the position first.
 */
export async function handleParsedSwap(parsed: ParsedSwap): Promise<void> {
  let sellBuffered = false;
  let sellBufferMs = 0;

  // Fix A: If this is a SELL, no position exists, but a BUY for this mint
  // is pending (detected but not yet processed), buffer OUTSIDE the mutex
  // to let the BUY go through first.
  if (parsed.direction === 'SELL' && hasPendingBuy(parsed.tokenMint)) {
    const pos = getPosition(parsed.tokenMint);
    if (!pos || BigInt(pos.amount_raw) === 0n) {
      sellBuffered = true;
      const bufferStart = Date.now();
      logger.info(
        { mint: parsed.tokenMint, sig: parsed.signature },
        '[SELL-BUFFER] No position yet but BUY pending — waiting outside mutex (up to 4s)',
      );
      for (let i = 0; i < 8; i++) {
        await sleepMs(500);
        const p = getPosition(parsed.tokenMint);
        if (p && BigInt(p.amount_raw) > 0n) {
          logger.info({ mint: parsed.tokenMint, waitMs: (i + 1) * 500 }, '[SELL-BUFFER] Position appeared');
          break;
        }
        if (!hasPendingBuy(parsed.tokenMint)) {
          logger.info({ mint: parsed.tokenMint }, '[SELL-BUFFER] Pending BUY completed/cleared, proceeding');
          break;
        }
      }
      sellBufferMs = Date.now() - bufferStart;
    }
  }

  return withMutex(() => _handleParsedSwapInner(parsed, sellBuffered, sellBufferMs));
}

async function _handleParsedSwapInner(
  parsed: ParsedSwap,
  sellBuffered = false,
  sellBufferMs = 0,
): Promise<void> {
  if (isEventProcessed(parsed.signature)) return;

  markEventProcessed(parsed.signature);

  const tDetected = Date.now();

  recordSourceTrade(
    parsed.signature,
    parsed.direction,
    parsed.tokenMint,
    parsed.solAmount,
    parsed.tokenAmount.toString(),
  );

  try {
    const riskResult = await evaluateRisk(parsed);

    const tRiskDone = Date.now();
    const riskMs = tRiskDone - tDetected;

    if (riskResult.action === 'REJECT') {
      updateSourceTradeAction(parsed.signature, 'REJECTED', 0, riskResult.reason);
      logger.warn({
        reason: riskResult.reason,
        sig: parsed.signature,
        dir: parsed.direction,
        mint: parsed.tokenMint,
        source: parsed._source,
        unsafeParse: parsed._unsafe_parse,
        sellBuffered,
        latency_risk_ms: riskMs,
      }, 'Trade rejected');
      notifyTradeRejected(parsed, riskResult.reason ?? 'Unknown');

      // A4: track outcome for circuit breaker
      const isNoPos = (riskResult.reason ?? '').includes('No position found');
      recordOutcome(isNoPos ? 'NO_POSITION' : 'REJECTED', riskMs);

      try {
        recordPipelineMetric({
          signature: parsed.signature, direction: parsed.direction, mint: parsed.tokenMint,
          source: parsed._source ?? 'unknown',
          outcome: riskResult.reason === 'CIRCUIT_BREAKER' ? 'CIRCUIT_BREAKER' : 'REJECTED',
          reject_reason: riskResult.reason,
          sell_buffered: sellBuffered, sell_buffer_ms: sellBufferMs,
          latency_risk_ms: riskMs, latency_exec_ms: 0, latency_total_ms: riskMs,
          price_drift_pct: riskResult.priceDriftPct,
          unsafe_parse: parsed._unsafe_parse,
          sell_on_sent_ms: riskResult.sellOnSentWaitMs,
        });
      } catch { /* non-critical */ }
      return;
    }

    const plan = riskResult.tradePlan!;
    const tOrderSent = Date.now();
    const result = await executeSwap(plan);
    const tOrderDone = Date.now();
    const execMs = tOrderDone - tOrderSent;
    const totalMs = tOrderDone - tDetected;

    if (result.success) {
      const botSol = plan.direction === 'BUY'
        ? Number(plan.amountRaw) / 1e9
        : Number(plan.quote.outAmount) / 1e9;
      updateSourceTradeAction(parsed.signature, 'COPIED', botSol);
      updatePosition(plan, result.quoteOutAmount ?? plan.quote.outAmount);
      notifyTradeExecuted(parsed, plan, result.txSignature);
      logger.info({
        sig: result.txSignature,
        dir: plan.direction,
        mint: plan.mint,
        source: parsed._source,
        unsafeParse: parsed._unsafe_parse,
        sellBuffered,
        latency_risk_ms: riskMs,
        latency_exec_ms: execMs,
        latency_total_ms: totalMs,
      }, 'Trade executed');

      // A4: track outcome for circuit breaker
      recordOutcome('COPIED', totalMs);

      try {
        recordPipelineMetric({
          signature: parsed.signature, direction: parsed.direction, mint: parsed.tokenMint,
          source: parsed._source ?? 'unknown', outcome: 'COPIED',
          sell_buffered: sellBuffered, sell_buffer_ms: sellBufferMs,
          latency_risk_ms: riskMs, latency_exec_ms: execMs, latency_total_ms: totalMs,
          price_drift_pct: riskResult.priceDriftPct,
          unsafe_parse: parsed._unsafe_parse,
          sell_on_sent_ms: riskResult.sellOnSentWaitMs,
        });
      } catch { /* non-critical */ }

      try {
        const pnl = getVirtualPnL();
        recordPnlSnapshot(getVirtualCash(), pnl.pnl);
      } catch { /* non-critical */ }
    } else {
      updateSourceTradeAction(parsed.signature, 'FAILED', 0, result.error);
      logger.error({ error: result.error, dir: plan.direction, mint: plan.mint }, 'Trade failed');
      notifyError(`Trade failed for ${plan.mint}: ${result.error}`);

      // A4: track outcome for circuit breaker
      recordOutcome('FAILED', totalMs);

      try {
        recordPipelineMetric({
          signature: parsed.signature, direction: parsed.direction, mint: parsed.tokenMint,
          source: parsed._source ?? 'unknown', outcome: 'FAILED',
          reject_reason: result.error,
          sell_buffered: sellBuffered, sell_buffer_ms: sellBufferMs,
          latency_risk_ms: riskMs, latency_exec_ms: execMs, latency_total_ms: totalMs,
          unsafe_parse: parsed._unsafe_parse,
        });
      } catch { /* non-critical */ }
    }
  } finally {
    if (parsed.direction === 'BUY') {
      clearPendingBuy(parsed.tokenMint);
    }
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
