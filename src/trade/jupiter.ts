import { VersionedTransaction } from '@solana/web3.js';
import { getConfig, SOL_MINT, lamportsToSol } from '../config';
import { getKeypair, getSharedConnection } from './solana';
import { addDailySpent, updateCooldown, recordVirtualTrade, getVirtualPnL, getPosition } from '../db/repo';
import { logger } from '../utils/logger';
import type { TradePlan } from '../risk/engine';

const JUPITER_API = 'https://api.jup.ag/swap/v1';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

// Realistic fee estimation for simulation accuracy
const BASE_TX_FEE_LAMPORTS = 5_000;           // 0.000005 SOL
const ATA_CREATION_LAMPORTS = 2_039_280;       // ~0.00204 SOL (rent-exempt minimum)
const estimateTxFeeSol = (config: ReturnType<typeof getConfig>, isNewToken: boolean): number => {
  let fee = BASE_TX_FEE_LAMPORTS + config.PRIORITY_FEE_LAMPORTS;
  if (isNewToken) fee += ATA_CREATION_LAMPORTS;
  return lamportsToSol(fee);
};

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

    // Compare actual execution vs quote estimate (sim vs real)
    compareExecution(connection, txSignature, keypair.publicKey.toBase58(), plan, quote).catch(() => {});

    logger.info({ txSignature }, 'Transaction confirmed');
    return { success: true, txSignature, quoteOutAmount: quote.outAmount };
  } catch (err) {
    return { success: false, error: `Swap error: ${(err as Error).message}` };
  }
}

function executeDryRun(plan: TradePlan, quote: JupiterQuote): SwapResult {
  const config = getConfig();
  const isNewToken = plan.direction === 'BUY' && !getPosition(plan.mint);
  const txFee = estimateTxFeeSol(config, isNewToken);

  // Virtual balance check — prevent simulated overspending
  if (plan.direction === 'BUY') {
    const pnlBefore = getVirtualPnL();
    const virtualBalance = config.VIRTUAL_STARTING_BALANCE + pnlBefore.pnl;
    const needed = lamportsToSol(plan.amountRaw) + txFee;
    if (needed > virtualBalance) {
      logger.warn(
        { needed: needed.toFixed(6), available: virtualBalance.toFixed(6), mint: plan.mint },
        '[DRY RUN] Insufficient virtual balance, skipping',
      );
      return { success: false, error: `Insufficient virtual balance: need ${needed.toFixed(4)} SOL, have ${virtualBalance.toFixed(4)}` };
    }
  }

  // Include estimated fees in the SOL amounts for realistic PNL
  const solVal = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw) + txFee   // total cost = swap + fees
    : lamportsToSol(BigInt(quote.outAmount)) - txFee; // net received = output - fees

  const tokenVal = plan.direction === 'BUY'
    ? quote.outAmount
    : plan.amountRaw.toString();

  const tokenPrice = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw) / (Number(quote.outAmount) || 1)
    : lamportsToSol(BigInt(quote.outAmount)) / (Number(plan.amountRaw) || 1);

  const sig = `DRY_${Date.now()}`;
  recordVirtualTrade(sig, plan.direction, plan.mint, Math.max(solVal, 0), tokenVal, tokenPrice);

  const pnl = getVirtualPnL();

  logger.info(
    {
      dryRun: true,
      direction: plan.direction,
      mint: plan.mint,
      solAmount: solVal.toFixed(6),
      txFee: txFee.toFixed(6),
      isNewToken,
      tokenAmount: tokenVal,
      priceImpact: quote.priceImpactPct,
      pnl: `${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL`,
      spent: pnl.totalSpent.toFixed(4),
      received: pnl.totalReceived.toFixed(4),
    },
    '[DRY RUN] Virtual trade executed (fees included)',
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

// ── Sim vs Real Comparison ────────────────────────

async function compareExecution(
  connection: ReturnType<typeof getSharedConnection>,
  signature: string,
  botWallet: string,
  plan: TradePlan,
  quote: JupiterQuote,
): Promise<void> {
  await sleep(2000); // wait for finalization
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) return;

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(botWallet);
  if (idx === -1) return;

  const realSolDelta = Math.abs(tx.meta.postBalances[idx] - tx.meta.preBalances[idx]);
  const quoteSolAmount = plan.direction === 'BUY'
    ? Number(plan.amountRaw)
    : Number(quote.outAmount);

  const errorAbs = lamportsToSol(Math.abs(realSolDelta - quoteSolAmount));
  const errorPct = quoteSolAmount > 0 ? (Math.abs(realSolDelta - quoteSolAmount) / quoteSolAmount) * 100 : 0;

  logger.info(
    {
      sig: signature,
      direction: plan.direction,
      mint: plan.mint,
      quoteSol: lamportsToSol(quoteSolAmount).toFixed(6),
      realSol: lamportsToSol(realSolDelta).toFixed(6),
      errorAbs: errorAbs.toFixed(6),
      errorPct: errorPct.toFixed(2) + '%',
      realFee: lamportsToSol(tx.meta.fee).toFixed(6),
    },
    '[AUDIT] Sim vs Real comparison',
  );
}
