import { VersionedTransaction } from '@solana/web3.js';
import { getConfig, lamportsToSol } from '../config';
import { getKeypair, getSharedConnection } from './solana';
import { addDailySpent, updateCooldown, recordVirtualTrade, getPosition, recordComparison } from '../db/repo';
import { notifyError } from '../notify/telegram';
import { logger } from '../utils/logger';
import type { TradePlan } from '../risk/engine';

const JUPITER_API = 'https://api.jup.ag/swap/v1';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

const BASE_TX_FEE_LAMPORTS = 5_000;
const ATA_CREATION_LAMPORTS = 2_039_280;

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
  quoteOutAmount?: string;
  error?: string;
}

export async function executeSwap(plan: TradePlan): Promise<SwapResult> {
  const config = getConfig();
  const keypair = getKeypair();
  const quote = plan.quote;

  try {
    if (config.DRY_RUN) {
      return config.DRY_RUN_ACCURATE
        ? await executeDryRunAccurate(plan, quote)
        : executeDryRunEstimate(plan, quote);
    }

    // ── LIVE execution ──
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
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([keypair]);

    const connection = getSharedConnection();
    const rawTx = transaction.serialize();

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

    compareExecution(connection, txSignature, keypair.publicKey.toBase58(), plan, quote).catch(() => {});

    logger.info({ txSignature }, 'Transaction confirmed');
    return { success: true, txSignature, quoteOutAmount: quote.outAmount };
  } catch (err) {
    return { success: false, error: `Swap error: ${(err as Error).message}` };
  }
}

// ── DRY_RUN: Estimate mode (fast, ~fixed fee) ────

function executeDryRunEstimate(plan: TradePlan, quote: JupiterQuote): SwapResult {
  const config = getConfig();
  const isNewToken = plan.direction === 'BUY' && !getPosition(plan.mint);
  let feeLamports = BASE_TX_FEE_LAMPORTS + config.PRIORITY_FEE_LAMPORTS;
  if (isNewToken) feeLamports += ATA_CREATION_LAMPORTS;
  const txFee = lamportsToSol(feeLamports);

  logger.info({
    mode: 'ESTIMATE',
    feeLamports,
    txFee: txFee.toFixed(6),
    isNewToken,
    ataIncluded: isNewToken,
  }, '[DRY RUN] Fee estimation (fixed)');

  return recordDryRunTrade(plan, quote, txFee);
}

// ── DRY_RUN: Accurate mode (simulateTransaction) ──

async function executeDryRunAccurate(plan: TradePlan, quote: JupiterQuote): Promise<SwapResult> {
  const config = getConfig();
  const keypair = getKeypair();

  try {
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
      logger.warn('[DRY_RUN_ACCURATE] Jupiter /swap failed, falling back to estimate');
      return executeDryRunEstimate(plan, quote);
    }

    const swapData = (await swapRes.json()) as JupiterSwapResponse;
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);

    // Parse ComputeBudget instructions for accurate fee
    const { computeUnitLimit, computeUnitPrice } = parseComputeBudget(transaction);

    const connection = getSharedConnection();
    const simResult = await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (simResult.value.err) {
      logger.warn({ err: simResult.value.err, mint: plan.mint }, '[DRY_RUN_ACCURATE] Simulation failed');
      return { success: false, error: `Simulation failed: ${JSON.stringify(simResult.value.err)}` };
    }

    const unitsUsed = simResult.value.unitsConsumed ?? computeUnitLimit;
    const priorityFeeLamports = Math.ceil(Number(computeUnitPrice) * unitsUsed / 1_000_000);
    const totalFeeLamports = BASE_TX_FEE_LAMPORTS + priorityFeeLamports;
    const txFee = lamportsToSol(totalFeeLamports);

    logger.info({
      mode: 'ACCURATE',
      unitsUsed,
      computeUnitPrice: Number(computeUnitPrice),
      priorityFeeLamports,
      totalFeeLamports,
      txFee: txFee.toFixed(6),
    }, '[DRY_RUN_ACCURATE] Simulation fee breakdown');

    return recordDryRunTrade(plan, quote, txFee);
  } catch (err) {
    logger.warn({ err }, '[DRY_RUN_ACCURATE] Error, falling back to estimate');
    return executeDryRunEstimate(plan, quote);
  }
}

function parseComputeBudget(tx: VersionedTransaction): { computeUnitLimit: number; computeUnitPrice: bigint } {
  let limit = 200_000;
  let price = 0n;
  const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
  const keys = tx.message.staticAccountKeys;

  for (const ix of tx.message.compiledInstructions) {
    if (keys[ix.programIdIndex]?.toBase58() !== COMPUTE_BUDGET) continue;
    const d = ix.data;
    if (d.length === 0) continue;

    if (d[0] === 2 && d.length >= 5) {
      limit = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
    } else if (d[0] === 3 && d.length >= 9) {
      price = BigInt(d[1]) | (BigInt(d[2]) << 8n) | (BigInt(d[3]) << 16n) |
        (BigInt(d[4]) << 24n) | (BigInt(d[5]) << 32n) | (BigInt(d[6]) << 40n) |
        (BigInt(d[7]) << 48n) | (BigInt(d[8]) << 56n);
    }
  }
  return { computeUnitLimit: limit, computeUnitPrice: price };
}

// ── Shared dry-run trade recording ────────────────

function recordDryRunTrade(plan: TradePlan, quote: JupiterQuote, txFee: number): SwapResult {
  const solVal = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw) + txFee
    : Math.max(lamportsToSol(BigInt(quote.outAmount)) - txFee, 0);

  const tokenVal = plan.direction === 'BUY'
    ? quote.outAmount
    : plan.amountRaw.toString();

  const tokenPrice = plan.direction === 'BUY'
    ? lamportsToSol(plan.amountRaw) / (Number(quote.outAmount) || 1)
    : lamportsToSol(BigInt(quote.outAmount)) / (Number(plan.amountRaw) || 1);

  const sig = `DRY_${Date.now()}`;
  recordVirtualTrade(sig, plan.direction, plan.mint, solVal, tokenVal, tokenPrice);

  if (plan.direction === 'BUY') addDailySpent(lamportsToSol(plan.amountRaw));
  updateCooldown(plan.mint);

  logger.info(
    {
      dryRun: true,
      direction: plan.direction,
      mint: plan.mint,
      swapSol: lamportsToSol(plan.amountRaw).toFixed(6),
      txFee: txFee.toFixed(6),
      totalSol: solVal.toFixed(6),
      tokenAmount: tokenVal,
      priceImpact: quote.priceImpactPct,
    },
    '[DRY RUN] Virtual trade executed',
  );

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

// ── Sim vs Real Comparison (LIVE mode) ────────────

async function compareExecution(
  connection: ReturnType<typeof getSharedConnection>,
  signature: string,
  botWallet: string,
  plan: TradePlan,
  quote: JupiterQuote,
): Promise<void> {
  await sleep(2500);
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) return;

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const walletIdx = keys.indexOf(botWallet);
  if (walletIdx === -1) return;

  // SOL delta (lamports)
  const preSol = tx.meta.preBalances[walletIdx];
  const postSol = tx.meta.postBalances[walletIdx];
  const deltaSol = postSol - preSol;

  // Token delta for the specific mint
  let preToken = 0n;
  let postToken = 0n;
  for (const tb of tx.meta.preTokenBalances ?? []) {
    if (tb.owner === botWallet && tb.mint === plan.mint) {
      preToken = BigInt(tb.uiTokenAmount.amount);
    }
  }
  for (const tb of tx.meta.postTokenBalances ?? []) {
    if (tb.owner === botWallet && tb.mint === plan.mint) {
      postToken = BigInt(tb.uiTokenAmount.amount);
    }
  }
  const deltaToken = postToken - preToken;

  // Quote expectations
  const quoteSolLamports = plan.direction === 'BUY'
    ? Number(plan.amountRaw)
    : Number(quote.outAmount);
  const quoteTokenRaw = plan.direction === 'BUY'
    ? BigInt(quote.outAmount)
    : plan.amountRaw;

  // Meaningful comparison: for BUY compare tokens received, for SELL compare SOL received
  const realTokenAbs = deltaToken < 0n ? -deltaToken : deltaToken;
  const tokenSlippage = quoteTokenRaw > 0n
    ? Number((realTokenAbs - quoteTokenRaw) * 10000n / quoteTokenRaw) / 100
    : 0;

  const realSolNet = Math.abs(deltaSol) - tx.meta.fee;
  const solSlippage = quoteSolLamports > 0
    ? ((realSolNet - quoteSolLamports) / quoteSolLamports) * 100
    : 0;

  const cu = (tx.meta as any).computeUnitsConsumed ?? 0;

  logger.info(
    {
      sig: signature,
      direction: plan.direction,
      mint: plan.mint,
      preSol: lamportsToSol(preSol).toFixed(6),
      postSol: lamportsToSol(postSol).toFixed(6),
      deltaSol: lamportsToSol(deltaSol).toFixed(6),
      preToken: preToken.toString(),
      postToken: postToken.toString(),
      deltaToken: deltaToken.toString(),
      fee: lamportsToSol(tx.meta.fee).toFixed(6),
      computeUnits: cu,
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : 'N/A',
      quoteSol: lamportsToSol(quoteSolLamports).toFixed(6),
      quoteToken: quoteTokenRaw.toString(),
      solSlippagePct: solSlippage.toFixed(3) + '%',
      tokenSlippagePct: tokenSlippage.toFixed(3) + '%',
    },
    '[AUDIT] Sim vs Real comparison',
  );

  try {
    recordComparison({
      signature,
      direction: plan.direction,
      mint: plan.mint,
      quote_sol_lamports: quoteSolLamports,
      real_sol_delta: deltaSol,
      real_fee_lamports: tx.meta.fee,
      quote_token: quoteTokenRaw.toString(),
      real_token_delta: deltaToken.toString(),
      sol_slippage_pct: +solSlippage.toFixed(3),
      token_slippage_pct: +tokenSlippage.toFixed(3),
      compute_units: cu,
    });
  } catch { /* non-critical */ }

  const config = getConfig();
  const absSlippage = Math.max(Math.abs(solSlippage), Math.abs(tokenSlippage));
  if (absSlippage > config.COMPARE_ALERT_PCT) {
    notifyError(
      `[SLIPPAGE ALERT] ${plan.direction} ${plan.mint.slice(0, 8)}… — ` +
      `SOL ${solSlippage.toFixed(2)}% / Token ${tokenSlippage.toFixed(2)}% ` +
      `(seuil: ${config.COMPARE_ALERT_PCT}%)`,
    );
  }
}
