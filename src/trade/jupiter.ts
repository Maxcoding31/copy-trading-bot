import { VersionedTransaction } from '@solana/web3.js';
import { getConfig, SOL_MINT, lamportsToSol } from '../config';
import { getKeypair, getSharedConnection } from './solana';
import { addDailySpent, updateCooldown, recordVirtualTrade, getVirtualPnL } from '../db/repo';
import { logger } from '../utils/logger';
import type { TradePlan } from '../risk/engine';

const JUPITER_API = 'https://api.jup.ag/swap/v1';

// Aggressive retry for memecoins – every ms counts
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

// ── Jupiter Quote ──────────────────────────────────

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: unknown[];
  [key: string]: unknown;
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
): Promise<JupiterQuote | null> {
  const config = getConfig();
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: config.SLIPPAGE_BPS.toString(),
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  const headers: Record<string, string> = { 'x-api-key': config.JUPITER_API_KEY };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${JUPITER_API}/quote?${params}`, { headers });
      if (!res.ok) {
        const body = await res.text();
        logger.warn({ status: res.status, body, attempt }, 'Jupiter quote failed');
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * attempt); continue; }
        return null;
      }
      const data = (await res.json()) as JupiterQuote;
      if (!data.routePlan || (Array.isArray(data.routePlan) && data.routePlan.length === 0)) {
        logger.warn({ inputMint, outputMint }, 'Jupiter returned no routes');
        return null;
      }
      return data;
    } catch (err) {
      logger.error({ err, attempt }, 'Jupiter quote fetch error');
      if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * attempt); continue; }
      return null;
    }
  }
  return null;
}

// ── Jupiter Swap ───────────────────────────────────

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface SwapResult {
  success: boolean;
  txSignature?: string;
  /** Actual token output amount (from quote) for position tracking */
  quoteOutAmount?: string;
  error?: string;
}

/**
 * Execute a swap using the pre-validated Jupiter quote from the risk engine.
 * No second quote call needed – saves ~1-2 seconds per trade.
 */
export async function executeSwap(plan: TradePlan): Promise<SwapResult> {
  const config = getConfig();
  const keypair = getKeypair();
  const quote = plan.quote;

  try {
    // ── DRY_RUN: full simulation with virtual P&L ──
    if (config.DRY_RUN) {
      return executeDryRun(plan, quote);
    }

    // ── LIVE: build swap transaction from the pre-fetched quote ──
    const swapRes = await fetchWithRetry(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.JUPITER_API_KEY },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: config.PRIORITY_FEE_LAMPORTS,
            priorityLevel: 'veryHigh',
          },
        },
      }),
    });

    if (!swapRes.ok) {
      const body = await swapRes.text();
      return { success: false, error: `Jupiter swap API: ${swapRes.status} – ${body}` };
    }

    const swapData = (await swapRes.json()) as JupiterSwapResponse;

    // Deserialize, sign, send
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);

    const connection = getSharedConnection();
    const rawTx = transaction.serialize();

    // skipPreflight saves ~400ms; confirmation catches failures
    const txSignature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });

    logger.info({ txSignature }, 'Transaction sent, confirming...');

    const confirmation = await connection.confirmTransaction(
      {
        signature: txSignature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: swapData.lastValidBlockHeight,
      },
      'confirmed',
    );

    if (confirmation.value.err) {
      return { success: false, error: `Tx failed: ${JSON.stringify(confirmation.value.err)}` };
    }

    if (plan.direction === 'BUY') addDailySpent(lamportsToSol(plan.amountRaw));
    updateCooldown(plan.mint);

    logger.info({ txSignature }, 'Transaction confirmed');
    return { success: true, txSignature, quoteOutAmount: quote.outAmount };
  } catch (err) {
    return { success: false, error: `Swap error: ${(err as Error).message}` };
  }
}

function executeDryRun(plan: TradePlan, quote: JupiterQuote): SwapResult {
  const solVal = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw)
    : lamportsToSol(BigInt(quote.outAmount));

  const tokenVal = plan.direction === 'BUY'
    ? quote.outAmount
    : plan.amountRaw.toString();

  const tokenPrice = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw) / (Number(quote.outAmount) || 1)
    : lamportsToSol(BigInt(quote.outAmount)) / (Number(plan.amountRaw) || 1);

  const sig = `DRY_${Date.now()}`;
  recordVirtualTrade(sig, plan.direction, plan.mint, solVal, tokenVal, tokenPrice);

  const pnl = getVirtualPnL();

  logger.info(
    {
      dryRun: true,
      direction: plan.direction,
      mint: plan.mint,
      solAmount: solVal.toFixed(6),
      tokenAmount: tokenVal,
      priceImpact: quote.priceImpactPct,
      pnl: `${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL`,
      spent: pnl.totalSpent.toFixed(4),
      received: pnl.totalReceived.toFixed(4),
    },
    '[DRY RUN] Virtual trade executed',
  );

  if (plan.direction === 'BUY') addDailySpent(lamportsToSol(plan.amountRaw));
  updateCooldown(plan.mint);

  return { success: true, txSignature: sig, quoteOutAmount: quote.outAmount };
}

// ── Helpers ────────────────────────────────────────

async function fetchWithRetry(url: string, init: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || i === retries) return res;
      await sleep(RETRY_BASE_MS * i);
    } catch (err) {
      if (i === retries) throw err;
      await sleep(RETRY_BASE_MS * i);
    }
  }
  throw new Error('fetchWithRetry exhausted');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
