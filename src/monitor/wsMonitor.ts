import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { getConfig, lamportsToSol } from '../config';
import { isEventProcessed } from '../db/repo';
import { handleParsedSwap, registerPendingBuy, type ParsedSwap } from '../webhook/handler';
import { logger } from '../utils/logger';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const POLL_INTERVAL_MS = 5_000; // P2: reduced role — fallback only (was 2s)

const processing = new Set<string>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wsSubscriptionId: number | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function clearProcessing(): void {
  processing.clear();
}

// ── WebSocket Monitor (P2 FIX) ──────────────────────

export function startWebSocketMonitor(connection: Connection): void {
  stopWebSocketMonitor();

  const config = getConfig();
  const sourceWallet = config.SOURCE_WALLET;
  const walletPubkey = new PublicKey(sourceWallet);

  logger.info({ sourceWallet }, 'WebSocket monitor starting (onLogs)');

  try {
    wsSubscriptionId = connection.onLogs(
      walletPubkey,
      async (logs: Logs) => {
        const sig = logs.signature;
        if (logs.err) return;
        if (isEventProcessed(sig)) return;
        if (processing.has(sig)) return;
        processing.add(sig);

        try {
          const parsed = await parseSwapFromRpc(connection, sig, sourceWallet);
          if (parsed) {
            parsed._source = 'ws';
            if (parsed.direction === 'BUY') registerPendingBuy(parsed.tokenMint);
            logger.info(
              { source: 'ws', direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig },
              'WebSocket: swap detected',
            );
            await handleParsedSwap(parsed);
          }
        } catch (err) {
          logger.error({ err, sig }, 'WebSocket: error processing tx');
        } finally {
          processing.delete(sig);
        }
      },
      'confirmed',
    );

    logger.info({ subscriptionId: wsSubscriptionId }, 'WebSocket monitor connected');

    // Monitor WebSocket health — auto-reconnect on disconnect
    scheduleWsHealthCheck(connection);
  } catch (err) {
    logger.error({ err }, 'WebSocket monitor failed to start');
    // Will rely on polling fallback
  }
}

export function stopWebSocketMonitor(): void {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsSubscriptionId !== null) {
    // Fire and forget — we may not have a connection anymore
    try {
      const connection = require('../trade/solana').getSharedConnection() as Connection;
      connection.removeOnLogsListener(wsSubscriptionId).catch(() => {});
    } catch { /* ignore */ }
    wsSubscriptionId = null;
    logger.info('WebSocket monitor stopped');
  }
}

function scheduleWsHealthCheck(connection: Connection): void {
  wsReconnectTimer = setTimeout(async () => {
    try {
      // Simple health check: try to get slot
      await connection.getSlot();
      // Reschedule
      scheduleWsHealthCheck(connection);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'WebSocket health check failed, reconnecting...');
      startWebSocketMonitor(connection);
    }
  }, 30_000); // Check every 30s
}

// ── Polling Monitor (fallback) ──────────────────────

export function stopPollingMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Polling monitor stopped');
  }
}

export function startPollingMonitor(connection: Connection): void {
  stopPollingMonitor();

  const config = getConfig();
  const sourceWallet = config.SOURCE_WALLET;
  const walletPubkey = new PublicKey(sourceWallet);

  logger.info({ sourceWallet, intervalMs: POLL_INTERVAL_MS }, 'Polling monitor started (fallback, 5s)');

  async function poll() {
    try {
      const sigs = await connection.getSignaturesForAddress(walletPubkey, { limit: 5 });

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        if (isEventProcessed(sigInfo.signature)) continue;
        if (processing.has(sigInfo.signature)) continue;
        processing.add(sigInfo.signature);

        parseSwapFromRpc(connection, sigInfo.signature, sourceWallet)
          .then(async (parsed) => {
            if (parsed) {
              parsed._source = 'poll';
              if (parsed.direction === 'BUY') registerPendingBuy(parsed.tokenMint);
              logger.info(
                { source: 'poll', direction: parsed.direction, token: parsed.tokenMint, sol: parsed.solAmount, sig: parsed.signature },
                'Poll: swap detected',
              );
              await handleParsedSwap(parsed);
            }
          })
          .catch((err) => {
            logger.error({ err, sig: sigInfo.signature }, 'Poll: error processing tx');
          })
          .finally(() => {
            processing.delete(sigInfo.signature);
          });
      }
    } catch (err) {
      logger.error({ err }, 'Poll: error fetching signatures');
    }
  }

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  poll();
}

// ── RPC Swap Parser ─────────────────────────────────

export async function parseSwapFromRpc(
  connection: Connection,
  signature: string,
  sourceWallet: string,
): Promise<ParsedSwap | null> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

  if (!tx?.meta) return null;

  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    k.pubkey.toBase58(),
  );
  const walletIdx = accountKeys.indexOf(sourceWallet);
  if (walletIdx === -1) return null;

  // Net SOL change (lamports) — the only reliable source of truth
  const netSolLamports = tx.meta.postBalances[walletIdx] - tx.meta.preBalances[walletIdx];
  if (netSolLamports === 0) return null;

  const MIN_SOL_CHANGE_LAMPORTS = 50_000; // 0.00005 SOL
  if (Math.abs(netSolLamports) < MIN_SOL_CHANGE_LAMPORTS) return null;

  // Token balance changes owned by source wallet (exclude wrapped SOL)
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];

  const tokenMap = new Map<string, { pre: bigint; post: bigint; decimals: number }>();

  for (const tb of pre) {
    if (tb.owner !== sourceWallet || tb.mint === WSOL_MINT) continue;
    tokenMap.set(tb.mint, {
      pre: BigInt(tb.uiTokenAmount.amount),
      post: 0n,
      decimals: tb.uiTokenAmount.decimals,
    });
  }

  for (const tb of post) {
    if (tb.owner !== sourceWallet || tb.mint === WSOL_MINT) continue;
    const existing = tokenMap.get(tb.mint);
    if (existing) {
      existing.post = BigInt(tb.uiTokenAmount.amount);
    } else {
      tokenMap.set(tb.mint, {
        pre: 0n,
        post: BigInt(tb.uiTokenAmount.amount),
        decimals: tb.uiTokenAmount.decimals,
      });
    }
  }

  // Find token with largest absolute change
  let bestMint: string | null = null;
  let bestAbsDelta = 0n;
  let bestDecimals = 6;
  let bestDelta = 0n;

  for (const [mint, { pre: p, post: q, decimals }] of tokenMap) {
    const delta = q - p;
    const abs = delta < 0n ? -delta : delta;
    if (abs > bestAbsDelta) {
      bestAbsDelta = abs;
      bestMint = mint;
      bestDecimals = decimals;
      bestDelta = delta;
    }
  }

  if (!bestMint || bestAbsDelta === 0n) return null;

  const direction: 'BUY' | 'SELL' = netSolLamports > 0 ? 'SELL' : 'BUY';

  // Cross-validate: BUY should gain tokens, SELL should lose tokens
  if (direction === 'BUY' && bestDelta <= 0n) return null;
  if (direction === 'SELL' && bestDelta >= 0n) return null;

  return {
    signature,
    direction,
    tokenMint: bestMint,
    solAmount: lamportsToSol(Math.abs(netSolLamports)),
    tokenAmount: bestAbsDelta,
    tokenDecimals: bestDecimals,
  };
}
