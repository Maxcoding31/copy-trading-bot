import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig, solToLamports, SOL_MINT } from '../config';
import { getDailySpent, getLastTradeAt, getPosition, getOpenPositionCount } from '../db/repo';
import { checkTokenSafety } from './tokenSafety';
import { getJupiterQuote, type JupiterQuote } from '../trade/jupiter';
import { getSharedConnection } from '../trade/solana';
import { logger } from '../utils/logger';
import type { ParsedSwap } from '../webhook/handler';

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
}

export async function evaluateRisk(swap: ParsedSwap): Promise<RiskResult> {
  const config = getConfig();

  if (config.PAUSE_TRADING) {
    return reject('Trading is paused (PAUSE_TRADING=true)');
  }

  return swap.direction === 'BUY'
    ? evaluateBuy(swap, config)
    : evaluateSell(swap, config);
}

async function evaluateBuy(swap: ParsedSwap, config: ReturnType<typeof getConfig>): Promise<RiskResult> {
  const connection = getSharedConnection();
  const mint = swap.tokenMint;

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

  if (config.BLOCK_IF_MINT_AUTHORITY || config.BLOCK_IF_FREEZE_AUTHORITY) {
    const safety = await checkTokenSafety(connection, mint);
    if (!safety.safe) {
      return reject(`Token unsafe: ${safety.reason}`);
    }
  }

  const amountLamports = solToLamports(mySol);
  const quote = await getJupiterQuote(SOL_MINT, mint, amountLamports);
  if (!quote) {
    return reject(`No Jupiter route found for ${mint}`);
  }

  const priceImpactBps = Math.round((quote.priceImpactPct ?? 0) * 10000);
  if (priceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    return reject(`Price impact ${priceImpactBps}bps exceeds max ${config.MAX_PRICE_IMPACT_BPS}bps`);
  }

  logger.info({ mint, mySol, priceImpactBps, sourceSol, openPositions: openCount }, 'BUY risk check passed');

  return {
    action: 'EXECUTE',
    tradePlan: {
      direction: 'BUY',
      mint,
      amountRaw: amountLamports,
      quote,
      tokenDecimals: swap.tokenDecimals,
    },
  };
}

async function evaluateSell(swap: ParsedSwap, config: ReturnType<typeof getConfig>): Promise<RiskResult> {
  const connection = getSharedConnection();
  const mint = swap.tokenMint;

  const position = getPosition(mint);
  if (!position || BigInt(position.amount_raw) === 0n) {
    return reject(`No position found for ${mint}`);
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

  let quote = await getJupiterQuote(mint, SOL_MINT, myTokenToSell);
  if (!quote) {
    return reject(`No Jupiter route found for selling ${mint}`);
  }

  const priceImpactBps = Math.round((quote.priceImpactPct ?? 0) * 10000);
  if (priceImpactBps > config.MAX_PRICE_IMPACT_BPS) {
    logger.warn({ mint, priceImpactBps }, 'High price impact on sell, proceeding anyway');
  }

  logger.info(
    { mint, sellTokens: myTokenToSell.toString(), balance: myBalance.toString(), priceImpactBps },
    'SELL risk check passed',
  );

  return {
    action: 'EXECUTE',
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
