import { getPosition, upsertPosition, deletePosition } from '../db/repo';
import { logger } from '../utils/logger';
import type { TradePlan } from '../risk/engine';

/**
 * Update position tracking after a successful trade.
 * For BUY: uses the Jupiter quote outAmount (what the BOT actually receives).
 * For SELL: subtracts the sold amount from our tracked position.
 */
export function updatePosition(plan: TradePlan, quoteOutAmount: string): void {
  if (plan.direction === 'BUY') {
    handleBuy(plan, quoteOutAmount);
  } else {
    handleSell(plan);
  }
}

function handleBuy(plan: TradePlan, quoteOutAmount: string): void {
  const { mint, tokenDecimals } = plan;
  const tokensReceived = BigInt(quoteOutAmount);

  const current = getPosition(mint);
  const existing = current ? BigInt(current.amount_raw) : 0n;
  const newTotal = existing + tokensReceived;

  upsertPosition(mint, newTotal, tokenDecimals);
  logger.info(
    { mint, received: tokensReceived.toString(), total: newTotal.toString(), decimals: tokenDecimals },
    'Position increased after BUY',
  );
}

function handleSell(plan: TradePlan): void {
  const { mint, amountRaw: tokensSold } = plan;

  const current = getPosition(mint);
  if (!current) {
    logger.warn({ mint }, 'Sell executed but no tracked position');
    return;
  }

  const existing = BigInt(current.amount_raw);
  const remaining = existing - tokensSold;

  if (remaining <= 0n) {
    deletePosition(mint);
    logger.info({ mint, sold: tokensSold.toString() }, 'Position fully closed');
  } else {
    upsertPosition(mint, remaining, current.decimals);
    logger.info(
      { mint, sold: tokensSold.toString(), remaining: remaining.toString() },
      'Position partially reduced',
    );
  }
}
