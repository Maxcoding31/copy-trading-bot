/**
 * Generate a daily simulation report as JSON.
 * Usage: npx tsx src/scripts/reportDaily.ts [YYYY-MM-DD]
 * Output: reports/YYYY-MM-DD.json
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config';
import { initDb } from '../db/sqlite';
import {
  getVirtualPnL, getVirtualCash, getVirtualPortfolio,
  getDailySummary, getDailyComparisonMetrics,
  getPnlHistory, getOpenPositionCount,
} from '../db/repo';

const config = loadConfig();
initDb();

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const summary = getDailySummary(day);
const comparison = getDailyComparisonMetrics(day);
const pnl = getVirtualPnL();
const cash = getVirtualCash();
const portfolio = getVirtualPortfolio();
const openPositions = getOpenPositionCount();
const pnlHistory = getPnlHistory(24);

const report = {
  generatedAt: new Date().toISOString(),
  day,
  mode: config.DRY_RUN ? 'SIMULATION' : 'LIVE',
  config: {
    sourceWallet: config.SOURCE_WALLET,
    copyRatio: config.COPY_RATIO,
    maxSolPerTrade: config.MAX_SOL_PER_TRADE,
    slippageBps: config.SLIPPAGE_BPS,
    priorityFeeLamports: config.PRIORITY_FEE_LAMPORTS,
    dryRunAccurate: config.DRY_RUN_ACCURATE,
    maxFeePct: config.MAX_FEE_PCT,
    minSolReserve: config.MIN_SOL_RESERVE,
  },
  wallet: {
    startingBalance: config.VIRTUAL_STARTING_BALANCE,
    currentBalance: +(config.VIRTUAL_STARTING_BALANCE + pnl.pnl).toFixed(6),
    virtualCash: +cash.toFixed(6),
    totalInvested: +pnl.totalSpent.toFixed(6),
    totalReceived: +pnl.totalReceived.toFixed(6),
    pnl: +pnl.pnl.toFixed(6),
    pnlPercent: +(pnl.pnl / config.VIRTUAL_STARTING_BALANCE * 100).toFixed(2),
    openPositions,
  },
  dailySummary: summary,
  comparisonMetrics: comparison,
  positions: portfolio.map((p) => ({
    mint: p.mint,
    tokens: p.token_amount,
    invested: +p.total_spent.toFixed(6),
    received: +p.total_received.toFixed(6),
    pnl: +(p.total_received - p.total_spent).toFixed(6),
  })),
  pnlSnapshots: pnlHistory.length,
};

const dir = path.resolve(process.cwd(), 'reports');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const filePath = path.join(dir, `${day}.json`);
fs.writeFileSync(filePath, JSON.stringify(report, null, 2));

console.log(`\n[DAILY] Report generated: ${filePath}`);
console.log(`[METRICS] Day: ${day}`);
console.log(`[METRICS] Trades: ${summary.totalTrades} (${summary.buys} buys, ${summary.sells} sells)`);
console.log(`[METRICS] Volume: Buy ${summary.totalBuyVolume} SOL / Sell ${summary.totalSellVolume} SOL`);
console.log(`[METRICS] Net PnL: ${summary.netPnl > 0 ? '+' : ''}${summary.netPnl} SOL`);
console.log(`[METRICS] Win rate: ${summary.winRate}%`);
if (comparison) {
  console.log(`[METRICS] Comparisons: ${comparison.count}`);
  console.log(`[METRICS] Avg SOL slippage: ${comparison.avgSolSlippagePct}%`);
  console.log(`[METRICS] p95 SOL slippage: ${comparison.p95SolSlippagePct}%`);
  console.log(`[METRICS] Max SOL slippage: ${comparison.maxSolSlippagePct}%`);
} else {
  console.log(`[METRICS] No execution comparisons (simulation mode)`);
}
console.log(`[SIM] Virtual cash: ${cash.toFixed(4)} SOL`);
console.log(`[SIM] Total PnL: ${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SOL (${(pnl.pnl / config.VIRTUAL_STARTING_BALANCE * 100).toFixed(2)}%)`);
console.log(`[SIM] Open positions: ${openPositions}\n`);
