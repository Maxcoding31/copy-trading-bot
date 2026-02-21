import { getConfig, lamportsToSol } from '../config';
import { getVirtualPnL, getOpenPositionCount } from '../db/repo';
import { logger } from '../utils/logger';
import type { ParsedSwap } from '../webhook/handler';
import type { TradePlan } from '../risk/engine';

const TELEGRAM_API = 'https://api.telegram.org/bot';

async function sendMessage(text: string): Promise<void> {
  const config = getConfig();
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return;

  try {
    const url = `${TELEGRAM_API}${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'Telegram send failed');
    }
  } catch (err) {
    logger.error({ err }, 'Telegram notification error');
  }
}

export function notifyTradeExecuted(
  swap: ParsedSwap,
  plan: TradePlan,
  txSignature?: string,
): void {
  const config = getConfig();
  const dryTag = config.DRY_RUN ? ' [SIMULATION]' : '';
  const dir = plan.direction === 'BUY' ? '🟢 ACHAT' : '🔴 VENTE';

  const solAmount =
    plan.direction === 'BUY'
      ? `${lamportsToSol(plan.amountRaw).toFixed(6)} SOL`
      : `${plan.amountRaw.toString()} tokens`;

  const sig = txSignature?.startsWith('DRY_RUN')
    ? 'Simulation'
    : txSignature
      ? `<a href="https://solscan.io/tx/${txSignature}">Voir tx</a>`
      : 'N/A';

  const positions = getOpenPositionCount();

  const lines = [
    `${dir}${dryTag}`,
    `Token: <code>${plan.mint}</code>`,
    `Montant: ${solAmount}`,
    `Source: ${swap.solAmount.toFixed(6)} SOL`,
    `Positions ouvertes: ${positions}`,
    `Tx: ${sig}`,
  ];

  // Add virtual P&L in DRY_RUN mode
  if (config.DRY_RUN) {
    const pnl = getVirtualPnL();
    const pnlStr = pnl.pnl >= 0 ? `+${pnl.pnl.toFixed(4)}` : pnl.pnl.toFixed(4);
    lines.push('');
    lines.push(`📊 <b>P&L virtuel: ${pnlStr} SOL</b>`);
    lines.push(`Investi: ${pnl.totalSpent.toFixed(4)} | Reçu: ${pnl.totalReceived.toFixed(4)}`);
  }

  sendMessage(lines.join('\n'));
}

export function notifyTradeRejected(swap: ParsedSwap, reason: string): void {
  const dir = swap.direction === 'BUY' ? '🟡 ACHAT REJETÉ' : '🟡 VENTE REJETÉE';
  const msg = [
    dir,
    `Token: <code>${swap.tokenMint}</code>`,
    `Source: ${swap.solAmount.toFixed(6)} SOL`,
    `Raison: ${reason}`,
  ].join('\n');

  sendMessage(msg);
}

export function notifyError(error: string): void {
  sendMessage(`🚨 <b>ERREUR</b>\n${error}`);
}

export function notifyBudgetExhausted(spent: number, max: number): void {
  sendMessage(
    `⚠️ <b>Budget épuisé</b>\nDépensé: ${spent.toFixed(4)} SOL / ${max.toFixed(4)} SOL`,
  );
}

export function notifyStartup(publicKey: string, dryRun: boolean): void {
  const mode = dryRun ? '🧪 MODE SIMULATION' : '🟢 MODE LIVE';
  const config = getConfig();

  const lines = [
    `🤖 <b>Bot copy-trading démarré</b>`,
    `Mode: ${mode}`,
    `Wallet bot: <code>${publicKey}</code>`,
    `Source: <code>${config.SOURCE_WALLET}</code>`,
    `Ratio: ${(config.COPY_RATIO * 100).toFixed(0)}%`,
    `Max/trade: ${config.MAX_SOL_PER_TRADE} SOL`,
    `Max/jour: ${config.MAX_SOL_PER_DAY} SOL`,
    `Max positions: ${config.MAX_OPEN_POSITIONS}`,
  ];

  if (dryRun) {
    const pnl = getVirtualPnL();
    lines.push('');
    lines.push(`📊 P&L virtuel cumulé: ${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL`);
  }

  sendMessage(lines.join('\n'));
}
