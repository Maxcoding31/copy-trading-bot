import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig, solToLamports, lamportsToSol, SOL_MINT } from '../config';
import { getDailySpent, getLastTradeAt, getPosition, getOpenPositionCount, getVirtualCash } from '../db/repo';
import { checkTokenSafety } from './tokenSafety';
import { getJupiterQuote, type JupiterQuote } from '../trade/jupiter';
import { getSharedConnection, getKeypair } from '../trade/solana';
import { isCircuitOpen } from '../guard/circuitBreaker';
import { logger } from '../utils/logger';
import type { ParsedSwap } from '../webhook/handler';

const BASE_TX_FEE_LAMPORTS = 5_000;
const ATA_CREATION_LAMPORTS = 2_039_280;

function estimateFeeSol(config: ReturnType<typeof getConfig>, isNewToken: boolean): number {
  let fee = BASE_TX_FEE_LAMPORTS + config.PRIORITY_FEE_LAMPORTS;
  if (isNewToken) fee += ATA_CREATION_LAMPORTS;
  return lamportsToSol(fee);
}

export interface TradePlan {
  direction: 'BUY' | 'SELL';
  mint: string;
  /** Amount in lamports (BUY) or raw token units (SELL) */
  amountRaw: bigint;
  /** Pre-validated Jupiter quote – avoids a second API call at execution time */
  quote: JupiterQuote;
  tokenDecimals: number;
}

export interface RiskResult {
  action: 'EXECUTE' | 'REJECT';
  reason?: string;
  tradePlan?: TradePlan;
  /** Observed price drift % for BUY trades: (quote_price/source_price - 1) * 100 */
  priceDriftPct?: number;
  /** Milliseconds waited for SENT→CONFIRMED before processing a SELL */
  sellOnSentWaitMs?: number;
}

export async function evaluateRisk(swap: ParsedSwap): Promise<RiskResult> {
  const config = getConfig();

  if (config.PAUSE_TRADING) {
    return reject('Trading is paused (PAUSE_TRADING=true)');
  }

  // A4: Circuit breaker check
  if (isCircuitOpen()) {
    return reject('CIRCUIT_BREAKER');
  }

  return swap.direction === 'BUY'
    ? evaluateBuy(swap, config)
    : evaluateSell(swap, config);
}

async function evaluateBuy(swap: ParsedSwap, config: ReturnType<typeof getConfig>): Promise<RiskResult> {
  const connection = getSharedConnection();
  const mint = swap.tokenMint;

  // A2: Unsafe parse gate — reject if decimals were approximated and not allowed
  if (swap._unsafe_parse && !config.ALLOW_UNSAFE_PARSE_TRADES) {
    return reject('UNSAFE_PARSE');
  }

  const openCount = getOpenPositionCount();
  if (openCount >= config.MAX_OPEN_POSITIONS) {
    return reject(`Max open positions reached (${openCount}/${config.MAX_OPEN_POSITIONS})`);
  }

  const sourceSol = swap.solAmount;
  let mySol = Math.min(sourceSol * config.COPY_RATIO, config.MAX_SOL_PER_TRADE);

  if (mySol < config.MIN_SOL_PER_TRADE) {
    return reject(`Trade size ${mySol.toFixed(4)} SOL below minimum ${config.MIN_SOL_PER_TRADE}`);
  }

  const spent = getDailySpent();
  if (spent + mySol > config.MAX_SOL_PER_DAY) {
    const remaining = config.MAX_SOL_PER_DAY - spent;
    if (remaining < config.MIN_SOL_PER_TRADE) {
      return reject(`Daily budget exhausted (${spent.toFixed(4)}/${config.MAX_SOL_PER_DAY} SOL)`);
    }
    mySol = remaining;
  }

  // Cooldown only on BUY – never block sells
  const lastTrade = getLastTradeAt(mint);
  if (lastTrade) {
    const elapsed = (Date.now() - lastTrade.getTime()) / 1000;
    if (elapsed < config.COOLDOWN_SECONDS_PER_TOKEN) {
      return reject(`Cooldown active for ${mint}: ${Math.ceil(config.COOLDOWN_SECONDS_PER_TOKEN - elapsed)}s remaining`);
    }
  }

  // Fee guard: reject if fees dominate the trade
  // Fix B: Adaptive threshold — smaller trades tolerate higher fee %
  // because fixed costs (base fee + priority fee + ATA) are constant.
  const isNewToken = !getPosition(mint);
  const estFee = estimateFeeSol(config, isNewToken);
  const feePct = (estFee / mySol) * 100;
  const effectiveMaxFeePct = getAdaptiveFeePct(config.MAX_FEE_PCT, mySol);
  if (feePct > effectiveMaxFeePct) {
    return reject(`Fee overhead ${feePct.toFixed(1)}% exceeds adaptive max ${effectiveMaxFeePct.toFixed(1)}% (fee ~${estFee.toFixed(5)} SOL on ${mySol.toFixed(4)} SOL trade)`);
  }

  logger.debug({
    mint, feePct: feePct.toFixed(1), effectiveMaxFeePct: effectiveMaxFeePct.toFixed(1),
    estFee: estFee.toFixed(5), mySol: mySol.toFixed(4), isNewToken,
  }, 'Fee guard breakdown');

  // Balance guard
  if (config.DRY_RUN) {
    const cash = getVirtualCash();
    const totalNeeded = mySol + estFee + config.MIN_SOL_RESERVE;
    if (totalNeeded > cash) {
      return reject(`Insufficient virtual cash: need ${totalNeeded.toFixed(4)} SOL (swap ${mySol.toFixed(4)} + fee ${estFee.toFixed(5)} + reserve ${config.MIN_SOL_RESERVE}), have ${cash.toFixed(4)} SOL`);
    }
  } else {
    try {
      const kp = getKeypair();
      const balance = await connection.getBalance(kp.publicKey);
      const balanceSol = balance / 1e9;
      const totalNeeded = mySol + estFee + config.MIN_SOL_RESERVE;
      if (totalNeeded > balanceSol) {
        return reject(`[LIVE] Insufficient wallet balance: need ${totalNeeded.toFixed(4)} SOL, have ${balanceSol.toFixed(4)} SOL`);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to check wallet balance, proceeding');
    }
  }

  if (config.BLOCK_IF_MINT_AUTHORITY || config.BLOCK_IF_FREEZE_AUTHORITY) {
    const safety = await checkTokenSafety(connection, mint);
    if (!safety.safe) {
      return reject(`Token unsafe: ${safety.reason}`);
    }
  }

  const amountLamports = solToLamports(mySol);
  // Fix C: Retry Jupiter quote once after a short delay if first attempt fails
  let quote = await getJupiterQuote(SOL_MINT, mint, amountLamports);
  if (!quote) {
    logger.info({ mint }, 'Jupiter quote failed, retrying in 1.5s...');
    await sleepMs(1500);
    quote = await getJupiterQuote(SOL_MINT, mint, amountLamports);
  }
  if (!quote) {
    logger.warn(
      { mint, amountLamports: amountLamports.toString(), slippageBps: config.SLIPPAGE_BPS, restrictIntermediateTokens: config.RESTRICT_INTERMEDIATE_TOKENS },
      'UNROUTABLE_TOKEN: no Jupiter BUY route (after retry)',
    );
    return reject('UNROUTABLE_TOKEN');
  }

  const priceImpactBps = Math.round((quote.priceImpactPct ?? 0) * 10000);
  if (priceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    return reject(`Price impact ${priceImpactBps}bps exceeds max ${config.MAX_PRICE_IMPACT_BPS}bps`);
  }

  // ── Price Drift Guard ──────────────────────────────────────────────────────
  // Compares the source wallet's execution price with the bot's quoted price.
  // If the bot's quote price is significantly higher it means the token pumped
  // between when the source bought and when the bot is about to buy.
  // Formula:
  //   price_source = solAmount / (tokenAmount / 10^decimals)   [SOL per token]
  //   price_quote  = mySol     / (outAmount   / 10^decimals)   [SOL per token]
  //   drift = (price_quote / price_source - 1)
  //
  // Skip the guard if the parse was low-confidence (approximated decimals make drift unreliable).
  let priceDriftPct: number | null = null;
  const skipDriftGuard = swap._unsafe_parse === true && config.DISABLE_DRIFT_GUARD_ON_UNSAFE_PARSE;

  if (!skipDriftGuard) {
    priceDriftPct = computePriceDrift(swap.solAmount, swap.tokenAmount, mySol, quote.outAmount, swap.tokenDecimals);

    if (priceDriftPct !== null) {
      logger.debug(
        { mint, priceDriftPct: priceDriftPct.toFixed(2), threshold: (config.MAX_PRICE_DRIFT_PCT * 100).toFixed(0) },
        'Price drift check',
      );

      if (config.MAX_PRICE_DRIFT_PCT > 0 && priceDriftPct > config.MAX_PRICE_DRIFT_PCT * 100) {
        logger.warn(
          { mint, priceDriftPct: priceDriftPct.toFixed(2), threshold: (config.MAX_PRICE_DRIFT_PCT * 100).toFixed(0) },
          'Price drift too high — token pumped since source trade',
        );
        return { action: 'REJECT', reason: 'PRICE_DRIFT_TOO_HIGH', priceDriftPct };
      }
    }
  } else {
    logger.debug({ mint }, 'Price drift guard skipped (unsafe_parse + DISABLE_DRIFT_GUARD_ON_UNSAFE_PARSE=true)');
  }
  // ── End Price Drift Guard ──────────────────────────────────────────────────

  logger.info({ mint, mySol, priceImpactBps, estFee: estFee.toFixed(6), feePct: feePct.toFixed(1), sourceSol, openPositions: openCount, priceDriftPct: priceDriftPct?.toFixed(2), unsafeParse: swap._unsafe_parse }, 'BUY risk check passed');

  return {
    action: 'EXECUTE',
    priceDriftPct: priceDriftPct ?? undefined,
    tradePlan: {
      direction: 'BUY',
      mint,
      amountRaw: amountLamports,
      quote,
      tokenDecimals: swap.tokenDecimals,
    },
  };
}

/**
 * Compute price drift between source execution price and bot quote price.
 * Returns drift as a percentage (e.g. 15.3 = +15.3%), or null if inputs are invalid.
 */
function computePriceDrift(
  sourceSolAmount: number,
  sourceTokenAmount: bigint,
  botSolAmount: number,
  quoteOutAmount: string,
  decimals: number,
): number | null {
  if (sourceTokenAmount === 0n) return null;
  const quoteOut = BigInt(quoteOutAmount);
  if (quoteOut === 0n) return null;
  if (sourceSolAmount <= 0 || botSolAmount <= 0) return null;

  const scale = Math.pow(10, decimals);
  const priceSource = sourceSolAmount / (Number(sourceTokenAmount) / scale);
  const priceQuote = botSolAmount / (Number(quoteOut) / scale);

  if (priceSource <= 0) return null;

  return (priceQuote / priceSource - 1) * 100;
}

async function evaluateSell(swap: ParsedSwap, config: ReturnType<typeof getConfig>): Promise<RiskResult> {
  const connection = getSharedConnection();
  const mint = swap.tokenMint;

  const initialPosition = getPosition(mint);
  if (!initialPosition || BigInt(initialPosition.amount_raw) === 0n) {
    return reject(`No position found for ${mint}`);
  }

  // A1/A3: Handle SELL on SENT (unconfirmed) position
  let sellOnSentWaitMs = 0;

  if (initialPosition.status === 'SENT') {
    if (!config.ALLOW_SELL_ON_SENT_POSITION) {
      // Buffer: poll for CONFIRMED status up to SELL_ON_SENT_TIMEOUT_SECONDS
      const waitStart = Date.now();
      const pollMs = 500;
      const maxPolls = Math.max(1, Math.ceil((config.SELL_ON_SENT_TIMEOUT_SECONDS * 1000) / pollMs));

      let confirmed = false;
      for (let i = 0; i < maxPolls; i++) {
        await sleepMs(pollMs);
        const refreshed = getPosition(mint);
        if (!refreshed) break; // position was rolled back (failPosition)
        if (refreshed.status === 'CONFIRMED') {
          confirmed = true;
          break;
        }
      }

      sellOnSentWaitMs = Date.now() - waitStart;

      if (!confirmed) {
        logger.warn(
          { mint, sellOnSentWaitMs, timeoutSeconds: config.SELL_ON_SENT_TIMEOUT_SECONDS },
          'A1: SELL on SENT — timed out waiting for CONFIRMED → POSITION_NOT_CONFIRMED',
        );
        return { action: 'REJECT', reason: 'POSITION_NOT_CONFIRMED', sellOnSentWaitMs };
      }

      logger.info({ mint, sellOnSentWaitMs }, 'A1: SELL on SENT — confirmed after wait, proceeding');
    } else {
      logger.warn(
        { mint, status: 'SENT', sig: swap.signature },
        'A1: SELL on SENT (unconfirmed) position — proceeding immediately (ALLOW_SELL_ON_SENT_POSITION=true)',
      );
    }
  }

  // Re-read position after potential wait (state may have changed)
  const position = sellOnSentWaitMs > 0 ? (getPosition(mint) ?? initialPosition) : initialPosition;
  if (!position || BigInt(position.amount_raw) === 0n) {
    return { action: 'REJECT', reason: `No position found for ${mint}`, sellOnSentWaitMs };
  }

  const myBalance = BigInt(position.amount_raw);
  const sourceTokenSold = swap.tokenAmount;

  // Proportional sell: mirror the source's sell fraction via on-chain balance
  let myTokenToSell: bigint;

  const sellFraction = await estimateSourceSellFraction(
    connection, config.SOURCE_WALLET, mint, sourceTokenSold,
  );

  if (sellFraction !== null) {
    myTokenToSell = bigIntMulFraction(myBalance, sellFraction);
    logger.info(
      { mint, sellFraction: sellFraction.toFixed(4), myTokenToSell: myTokenToSell.toString() },
      'Proportional sell from source balance',
    );
  } else {
    // Cannot determine fraction → sell 100% (safe: avoids holding bags)
    myTokenToSell = myBalance;
    logger.warn({ mint }, 'Could not estimate source sell fraction, selling full position');
  }

  myTokenToSell = bigIntMin(myTokenToSell, myBalance);
  if (myTokenToSell <= 0n) myTokenToSell = myBalance;

  // NO cooldown on sells – always allow immediate exit

  // Fix C: Retry Jupiter quote once after a short delay if first attempt fails
  let quote = await getJupiterQuote(mint, SOL_MINT, myTokenToSell);
  if (!quote) {
    logger.info({ mint }, 'Jupiter sell quote failed, retrying in 1.5s...');
    await sleepMs(1500);
    quote = await getJupiterQuote(mint, SOL_MINT, myTokenToSell);
  }
  if (!quote) {
    logger.warn(
      { mint, tokens: myTokenToSell.toString(), slippageBps: config.SLIPPAGE_BPS, restrictIntermediateTokens: config.RESTRICT_INTERMEDIATE_TOKENS },
      'UNROUTABLE_TOKEN: no Jupiter SELL route (after retry)',
    );
    return { action: 'REJECT', reason: 'UNROUTABLE_TOKEN', sellOnSentWaitMs };
  }

  const priceImpactBps = Math.round((quote.priceImpactPct ?? 0) * 10000);
  if (priceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    logger.warn({ mint, priceImpactBps }, 'High price impact on sell, proceeding anyway');
  }

  logger.info(
    { mint, sellTokens: myTokenToSell.toString(), balance: myBalance.toString(), priceImpactBps, sellOnSentWaitMs },
    'SELL risk check passed',
  );

  return {
    action: 'EXECUTE',
    sellOnSentWaitMs,
    tradePlan: {
      direction: 'SELL',
      mint,
      amountRaw: myTokenToSell,
      quote,
      tokenDecimals: position.decimals,
    },
  };
}

async function estimateSourceSellFraction(
  connection: Connection,
  sourceWallet: string,
  mint: string,
  sourceTokenSold: bigint,
): Promise<number | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const ownerPubkey = new PublicKey(sourceWallet);
    const tokenAccounts = await connection.getTokenAccountsByOwner(ownerPubkey, { mint: mintPubkey });

    let currentBalance = 0n;
    for (const { account } of tokenAccounts.value) {
      const data = account.data;
      if (data.length >= 72) currentBalance += data.readBigUInt64LE(64);
    }

    const balanceBefore = currentBalance + sourceTokenSold;
    if (balanceBefore === 0n) return null;

    return Math.min(Number(sourceTokenSold) / Number(balanceBefore), 1.0);
  } catch (err) {
    logger.warn({ err, mint }, 'Failed to fetch source token balance for sell fraction');
    return null;
  }
}

/**
 * Fix B: Adaptive fee threshold based on trade size.
 * Smaller trades naturally have higher fee % due to fixed costs,
 * so we allow a higher tolerance for them.
 *
 * - Trades >= 0.5 SOL: use base MAX_FEE_PCT (e.g. 5%)
 * - Trades ~0.1 SOL:   allow up to 2x MAX_FEE_PCT (e.g. 10%)
 * - Trades ~0.03 SOL:  allow up to 3x MAX_FEE_PCT (e.g. 15%)
 */
function getAdaptiveFeePct(baseMaxPct: number, tradeSol: number): number {
  if (tradeSol >= 0.5) return baseMaxPct;
  if (tradeSol >= 0.1) return baseMaxPct * 2;
  return baseMaxPct * 3;
}

function reject(reason: string): RiskResult {
  return { action: 'REJECT', reason };
}

function bigIntMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function bigIntMulFraction(value: bigint, fraction: number): bigint {
  const PRECISION = 1_000_000n;
  return (value * BigInt(Math.round(fraction * Number(PRECISION)))) / PRECISION;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
