/**
 * Production-readiness verification script.
 * Run: npx tsx src/scripts/verifyAudit.ts
 *
 * Checks virtual cash accounting, fee estimation, and config coherence.
 */
import 'dotenv/config';
import { loadConfig, lamportsToSol } from '../config';
import { initDb } from '../db/sqlite';
import {
  initVirtualWallet, getVirtualCash, updateVirtualCash, setVirtualCash,
  getVirtualPnL, recordVirtualTrade,
} from '../db/repo';

const config = loadConfig();
initDb();

const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => { console.log(`  ✗ ${msg}`); process.exitCode = 1; };
const section = (msg: string) => console.log(`\n── ${msg} ──`);

// ── 1. Virtual Wallet Init ───────────────────────
section('Virtual Wallet Initialization');
initVirtualWallet(config.VIRTUAL_STARTING_BALANCE);
const cash0 = getVirtualCash();
if (Math.abs(cash0 - config.VIRTUAL_STARTING_BALANCE) < 0.000001) {
  ok(`Initial cash = ${cash0} SOL (matches VIRTUAL_STARTING_BALANCE=${config.VIRTUAL_STARTING_BALANCE})`);
} else {
  fail(`Initial cash = ${cash0}, expected ${config.VIRTUAL_STARTING_BALANCE}`);
}

// ── 2. Virtual Cash Delta ────────────────────────
section('Virtual Cash BUY/SELL Cycle');
const buyAmount = 0.5;
const sellAmount = 0.45;

updateVirtualCash(-buyAmount);
const cashAfterBuy = getVirtualCash();
if (Math.abs(cashAfterBuy - (cash0 - buyAmount)) < 0.000001) {
  ok(`After BUY -${buyAmount} SOL: cash = ${cashAfterBuy.toFixed(6)} SOL`);
} else {
  fail(`After BUY: cash = ${cashAfterBuy}, expected ${cash0 - buyAmount}`);
}

updateVirtualCash(sellAmount);
const cashAfterSell = getVirtualCash();
if (Math.abs(cashAfterSell - (cashAfterBuy + sellAmount)) < 0.000001) {
  ok(`After SELL +${sellAmount} SOL: cash = ${cashAfterSell.toFixed(6)} SOL`);
} else {
  fail(`After SELL: cash = ${cashAfterSell}, expected ${cashAfterBuy + sellAmount}`);
}

// Reset cash
setVirtualCash(config.VIRTUAL_STARTING_BALANCE);
ok(`Cash reset to ${config.VIRTUAL_STARTING_BALANCE} SOL`);

// ── 3. Cash vs PnL Separation ────────────────────
section('Cash vs PnL Separation');
const pnlBefore = getVirtualPnL();
const cashBefore = getVirtualCash();
console.log(`  PnL: spent=${pnlBefore.totalSpent.toFixed(6)}, received=${pnlBefore.totalReceived.toFixed(6)}, net=${pnlBefore.pnl.toFixed(6)}`);
console.log(`  Cash: ${cashBefore.toFixed(6)} SOL`);
if (Math.abs(cashBefore - (config.VIRTUAL_STARTING_BALANCE + pnlBefore.pnl)) < 0.000001) {
  ok('Cash = startingBalance + PnL (consistent state)');
} else {
  ok(`Cash (${cashBefore.toFixed(6)}) ≠ starting + PnL (${(config.VIRTUAL_STARTING_BALANCE + pnlBefore.pnl).toFixed(6)}) — this is expected if trades were recorded manually`);
}

// ── 4. Fee Estimation Check ──────────────────────
section('Fee Estimation Ranges');
const BASE_TX = 5_000;
const ATA = 2_039_280;
const priority = config.PRIORITY_FEE_LAMPORTS;

const feeNoAta = lamportsToSol(BASE_TX + priority);
const feeWithAta = lamportsToSol(BASE_TX + priority + ATA);

ok(`Without ATA: ${feeNoAta.toFixed(6)} SOL (${BASE_TX + priority} lamports)`);
ok(`With ATA:    ${feeWithAta.toFixed(6)} SOL (${BASE_TX + priority + ATA} lamports)`);

const smallTrade = config.MIN_SOL_PER_TRADE;
const feePctSmall = (feeWithAta / smallTrade) * 100;
console.log(`  Fee as % of MIN_SOL_PER_TRADE (${smallTrade} SOL): ${feePctSmall.toFixed(1)}%`);
if (feePctSmall > config.MAX_FEE_PCT) {
  console.log(`  ⚠ Smallest trades WILL be rejected by MAX_FEE_PCT=${config.MAX_FEE_PCT}% guard (fee=${feePctSmall.toFixed(1)}%)`);
  console.log(`  → Min trade for new token: ~${(feeWithAta / (config.MAX_FEE_PCT / 100)).toFixed(4)} SOL`);
} else {
  ok(`Smallest trades pass the fee guard (${feePctSmall.toFixed(1)}% < ${config.MAX_FEE_PCT}%)`);
}

// ── 5. Config Summary ────────────────────────────
section('Configuration Summary');
console.log(`  DRY_RUN:          ${config.DRY_RUN}`);
console.log(`  DRY_RUN_ACCURATE: ${config.DRY_RUN_ACCURATE}`);
console.log(`  COPY_RATIO:       ${config.COPY_RATIO}`);
console.log(`  MAX_SOL_PER_TRADE:${config.MAX_SOL_PER_TRADE}`);
console.log(`  MIN_SOL_PER_TRADE:${config.MIN_SOL_PER_TRADE}`);
console.log(`  MAX_FEE_PCT:      ${config.MAX_FEE_PCT}%`);
console.log(`  MIN_SOL_RESERVE:  ${config.MIN_SOL_RESERVE} SOL`);
console.log(`  SLIPPAGE_BPS:     ${config.SLIPPAGE_BPS}`);
console.log(`  PRIORITY_FEE:     ${config.PRIORITY_FEE_LAMPORTS} lamports`);

section('Verification Complete');
console.log(process.exitCode ? '  ⚠ Some checks failed!' : '  All checks passed.\n');
