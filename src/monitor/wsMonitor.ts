import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig, lamportsToSol } from '../config';
import { isEventProcessed } from '../db/repo';
import { handleParsedSwap, type ParsedSwap } from '../webhook/handler';
import { logger } from '../utils/logger';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const POLL_INTERVAL_MS = 2_000;

const processing = new Set<string>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function clearProcessing(): void {
  processing.clear();
}

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

  logger.info({ sourceWallet, intervalMs: POLL_INTERVAL_MS }, 'Polling monitor started');

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

  // Filter out token-to-token swaps where SOL change is just network fees
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
