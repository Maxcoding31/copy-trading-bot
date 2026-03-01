import { getDb } from './sqlite';

// ── Processed Events (idempotency) ─────────────────

export function isEventProcessed(signature: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM processed_events WHERE signature = ?')
    .get(signature);
  return !!row;
}

export function markEventProcessed(signature: string): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO processed_events (signature) VALUES (?)')
    .run(signature);
}

// ── Positions ──────────────────────────────────────

export interface PositionRow {
  mint: string;
  amount_raw: string;
  decimals: number;
  status: 'CONFIRMED' | 'SENT';
  updated_at: string;
}

export function getPosition(mint: string): PositionRow | null {
  return (
    (getDb()
      .prepare('SELECT * FROM positions WHERE mint = ?')
      .get(mint) as PositionRow | undefined) ?? null
  );
}

export function getOpenPositionCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE CAST(amount_raw AS INTEGER) > 0")
    .get() as { cnt: number };
  return row.cnt;
}

export function upsertPosition(mint: string, amountRaw: bigint, decimals: number): void {
  getDb()
    .prepare(
      `INSERT INTO positions (mint, amount_raw, decimals, updated_at, status)
       VALUES (?, ?, ?, datetime('now'), 'CONFIRMED')
       ON CONFLICT(mint) DO UPDATE SET
         amount_raw = excluded.amount_raw,
         decimals   = excluded.decimals,
         updated_at = excluded.updated_at,
         status     = excluded.status`,
    )
    .run(mint, amountRaw.toString(), decimals);
}

/**
 * A1: Create/increase a position with status='SENT' (tx broadcast, not yet confirmed).
 * Used in LIVE mode immediately after transaction is sent.
 */
export function setPendingPosition(mint: string, addAmountRaw: bigint, decimals: number): void {
  const existing = getDb()
    .prepare('SELECT amount_raw FROM positions WHERE mint = ?')
    .get(mint) as { amount_raw: string } | undefined;

  const existingAmt = existing ? BigInt(existing.amount_raw) : 0n;
  const newTotal = existingAmt + addAmountRaw;

  getDb()
    .prepare(
      `INSERT INTO positions (mint, amount_raw, decimals, updated_at, status)
       VALUES (?, ?, ?, datetime('now'), 'SENT')
       ON CONFLICT(mint) DO UPDATE SET
         amount_raw = ?,
         decimals   = excluded.decimals,
         updated_at = excluded.updated_at,
         status     = 'SENT'`,
    )
    .run(mint, newTotal.toString(), decimals, newTotal.toString());
}

/**
 * A1: Mark a position as CONFIRMED after on-chain confirmation.
 */
export function confirmPosition(mint: string): void {
  getDb()
    .prepare(`UPDATE positions SET status = 'CONFIRMED', updated_at = datetime('now') WHERE mint = ?`)
    .run(mint);
}

/**
 * A1: Rollback a SENT position by removing the pending amount.
 * If the resulting amount is zero, delete the position entirely.
 */
export function failPosition(mint: string, pendingAmountRaw: bigint): void {
  const existing = getDb()
    .prepare('SELECT amount_raw FROM positions WHERE mint = ?')
    .get(mint) as { amount_raw: string } | undefined;

  if (!existing) return;

  const remaining = BigInt(existing.amount_raw) - pendingAmountRaw;
  if (remaining <= 0n) {
    getDb().prepare('DELETE FROM positions WHERE mint = ?').run(mint);
  } else {
    getDb()
      .prepare(`UPDATE positions SET amount_raw = ?, status = 'CONFIRMED', updated_at = datetime('now') WHERE mint = ?`)
      .run(remaining.toString(), mint);
  }
}

/**
 * A1: Find positions stuck as SENT beyond the timeout (minutes).
 */
export function getStalePendingPositions(timeoutMinutes: number): PositionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM positions WHERE status = 'SENT'
       AND updated_at < datetime('now', ?)`,
    )
    .all(`-${timeoutMinutes} minutes`) as PositionRow[];
}

export function deletePosition(mint: string): void {
  getDb().prepare('DELETE FROM positions WHERE mint = ?').run(mint);
}

// ── Daily Budget ───────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailySpent(): number {
  const day = todayKey();
  const row = getDb()
    .prepare('SELECT spent_sol FROM budgets WHERE day = ?')
    .get(day) as { spent_sol: number } | undefined;
  return row?.spent_sol ?? 0;
}

export function addDailySpent(sol: number): void {
  const day = todayKey();
  getDb()
    .prepare(
      `INSERT INTO budgets (day, spent_sol)
       VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET spent_sol = spent_sol + excluded.spent_sol`,
    )
    .run(day, sol);
}

// ── Token Cooldowns ────────────────────────────────

export function getLastTradeAt(mint: string): Date | null {
  const row = getDb()
    .prepare('SELECT last_trade_at FROM token_cooldowns WHERE mint = ?')
    .get(mint) as { last_trade_at: string } | undefined;
  return row ? new Date(row.last_trade_at + 'Z') : null;
}

export function updateCooldown(mint: string): void {
  getDb()
    .prepare(
      `INSERT INTO token_cooldowns (mint, last_trade_at)
       VALUES (?, datetime('now'))
       ON CONFLICT(mint) DO UPDATE SET last_trade_at = datetime('now')`,
    )
    .run(mint);
}

// ── Virtual Wallet (explicit cash tracking) ───────

export function initVirtualWallet(startingSol: number): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO virtual_wallet (id, cash_sol) VALUES (1, ?)')
    .run(startingSol);
}

export function getVirtualCash(): number {
  const row = getDb()
    .prepare('SELECT cash_sol FROM virtual_wallet WHERE id = 1')
    .get() as { cash_sol: number } | undefined;
  return row?.cash_sol ?? 0;
}

export function updateVirtualCash(deltaSol: number): void {
  getDb()
    .prepare('UPDATE virtual_wallet SET cash_sol = cash_sol + ? WHERE id = 1')
    .run(deltaSol);
}

export function setVirtualCash(sol: number): void {
  getDb()
    .prepare('UPDATE virtual_wallet SET cash_sol = ? WHERE id = 1')
    .run(sol);
}

// ── Virtual P&L Tracking (DRY_RUN) ────────────────

export function recordVirtualTrade(
  signature: string,
  direction: 'BUY' | 'SELL',
  mint: string,
  solAmount: number,
  tokenAmount: string,
  tokenPrice: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO virtual_trades (signature, direction, mint, sol_amount, token_amount, token_price)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(signature, direction, mint, solAmount, tokenAmount, tokenPrice);

  if (direction === 'BUY') {
    getDb()
      .prepare(
        `INSERT INTO virtual_portfolio (mint, token_amount, avg_buy_sol, total_spent, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(mint) DO UPDATE SET
           token_amount = CAST((CAST(token_amount AS INTEGER) + CAST(excluded.token_amount AS INTEGER)) AS TEXT),
           total_spent = total_spent + excluded.total_spent,
           avg_buy_sol = (total_spent + excluded.total_spent) /
             CASE WHEN CAST(token_amount AS REAL) + CAST(excluded.token_amount AS REAL) = 0
               THEN 1 ELSE CAST(token_amount AS REAL) + CAST(excluded.token_amount AS REAL) END,
           updated_at = datetime('now')`,
      )
      .run(mint, tokenAmount, solAmount, solAmount);
    updateVirtualCash(-solAmount);
  } else {
    getDb()
      .prepare(
        `UPDATE virtual_portfolio SET
           token_amount = CAST(MAX(0, CAST(token_amount AS INTEGER) - CAST(? AS INTEGER)) AS TEXT),
           total_received = total_received + ?,
           updated_at = datetime('now')
         WHERE mint = ?`,
      )
      .run(tokenAmount, solAmount, mint);
    updateVirtualCash(solAmount);
  }
}

export interface VirtualPortfolioRow {
  mint: string;
  token_amount: string;
  total_spent: number;
  total_received: number;
}

export function getVirtualPortfolio(): VirtualPortfolioRow[] {
  return getDb()
    .prepare('SELECT mint, token_amount, total_spent, total_received FROM virtual_portfolio')
    .all() as VirtualPortfolioRow[];
}

export function getVirtualPnL(): { totalSpent: number; totalReceived: number; pnl: number } {
  const row = getDb()
    .prepare(
      'SELECT COALESCE(SUM(total_spent),0) as spent, COALESCE(SUM(total_received),0) as received FROM virtual_portfolio',
    )
    .get() as { spent: number; received: number };
  return {
    totalSpent: row.spent,
    totalReceived: row.received,
    pnl: row.received - row.spent,
  };
}

// ── Source Trade Tracking ──────────────────────────

export interface SourceTradeRow {
  id: number;
  signature: string;
  direction: string;
  mint: string;
  sol_amount: number;
  token_amount: string;
  bot_action: string;
  bot_sol_amount: number;
  reject_reason: string | null;
  created_at: string;
}

export function recordSourceTrade(
  signature: string,
  direction: string,
  mint: string,
  solAmount: number,
  tokenAmount: string,
): number {
  const result = getDb()
    .prepare(
      `INSERT INTO source_trades (signature, direction, mint, sol_amount, token_amount)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(signature, direction, mint, solAmount, tokenAmount);
  return result.lastInsertRowid as number;
}

export function updateSourceTradeAction(
  signature: string,
  botAction: string,
  botSolAmount: number,
  rejectReason?: string,
): void {
  getDb()
    .prepare(
      `UPDATE source_trades SET bot_action = ?, bot_sol_amount = ?, reject_reason = ?
       WHERE signature = ?`,
    )
    .run(botAction, botSolAmount, rejectReason ?? null, signature);
}

export function getRecentSourceTrades(limit = 50): SourceTradeRow[] {
  return getDb()
    .prepare('SELECT * FROM source_trades ORDER BY id DESC LIMIT ?')
    .all(limit) as SourceTradeRow[];
}

export function getRecentVirtualTrades(limit = 50) {
  return getDb()
    .prepare('SELECT * FROM virtual_trades ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{
      id: number;
      signature: string;
      direction: string;
      mint: string;
      sol_amount: number;
      token_amount: string;
      token_price: number;
      created_at: string;
    }>;
}

// ── PnL Snapshots ─────────────────────────────────

export function recordPnlSnapshot(balance: number, pnl: number): void {
  getDb()
    .prepare('INSERT INTO pnl_snapshots (balance, pnl) VALUES (?, ?)')
    .run(balance, pnl);
}

export function getPnlHistory(hoursBack = 24): Array<{ balance: number; pnl: number; timestamp: string }> {
  return getDb()
    .prepare(
      `SELECT balance, pnl, timestamp FROM pnl_snapshots
       WHERE timestamp >= datetime('now', ?)
       ORDER BY timestamp ASC`,
    )
    .all(`-${hoursBack} hours`) as Array<{ balance: number; pnl: number; timestamp: string }>;
}

// ── Database Cleanup ──────────────────────────────

export function cleanupOldEvents(keepHours = 48): number {
  const result = getDb()
    .prepare(`DELETE FROM processed_events WHERE received_at < datetime('now', ?)`)
    .run(`-${keepHours} hours`);
  return result.changes;
}

export function cleanupOldSnapshots(keepDays = 30): number {
  const result = getDb()
    .prepare(`DELETE FROM pnl_snapshots WHERE timestamp < datetime('now', ?)`)
    .run(`-${keepDays} days`);
  return result.changes;
}

// ── Execution Comparisons (LIVE mode) ─────────────

export interface ComparisonRow {
  signature: string;
  direction: string;
  mint: string;
  quote_sol_lamports: number;
  real_sol_delta: number;
  real_fee_lamports: number;
  quote_token: string;
  real_token_delta: string;
  sol_slippage_pct: number;
  token_slippage_pct: number;
  compute_units: number;
  created_at: string;
}

export function recordComparison(row: Omit<ComparisonRow, 'created_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO execution_comparisons
       (signature, direction, mint, quote_sol_lamports, real_sol_delta, real_fee_lamports,
        quote_token, real_token_delta, sol_slippage_pct, token_slippage_pct, compute_units)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.signature, row.direction, row.mint,
      row.quote_sol_lamports, row.real_sol_delta, row.real_fee_lamports,
      row.quote_token, row.real_token_delta,
      row.sol_slippage_pct, row.token_slippage_pct, row.compute_units,
    );
}

export function getDailyComparisonMetrics(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);
  const rows = getDb()
    .prepare(
      `SELECT sol_slippage_pct, token_slippage_pct
       FROM execution_comparisons WHERE DATE(created_at) = ?
       ORDER BY ABS(sol_slippage_pct) ASC`,
    )
    .all(d) as Array<{ sol_slippage_pct: number; token_slippage_pct: number }>;

  if (rows.length === 0) return null;

  const absSol = rows.map((r) => Math.abs(r.sol_slippage_pct)).sort((a, b) => a - b);
  const absToken = rows.map((r) => Math.abs(r.token_slippage_pct)).sort((a, b) => a - b);
  const p95Idx = Math.min(Math.floor(rows.length * 0.95), rows.length - 1);

  return {
    count: rows.length,
    avgSolSlippagePct: +(absSol.reduce((s, v) => s + v, 0) / absSol.length).toFixed(3),
    p95SolSlippagePct: +absSol[p95Idx].toFixed(3),
    maxSolSlippagePct: +absSol[absSol.length - 1].toFixed(3),
    avgTokenSlippagePct: +(absToken.reduce((s, v) => s + v, 0) / absToken.length).toFixed(3),
    p95TokenSlippagePct: +absToken[p95Idx].toFixed(3),
    maxTokenSlippagePct: +absToken[absToken.length - 1].toFixed(3),
  };
}

// ── Trade Pipeline Metrics (Instrumentation) ──────

export interface PipelineMetric {
  signature: string;
  direction: string;
  mint: string;
  source: string;
  outcome: string;
  reject_reason?: string;
  sell_buffered: boolean;
  sell_buffer_ms: number;
  latency_risk_ms: number;
  latency_exec_ms: number;
  latency_total_ms: number;
  /** Price drift % observed for BUY trades: (quote_price/source_price - 1) * 100 */
  price_drift_pct?: number;
  /** Whether this trade was parsed via the low-confidence nativeTransfers fallback */
  unsafe_parse?: boolean;
  /** Milliseconds waited for SENT→CONFIRMED before processing a SELL */
  sell_on_sent_ms?: number;
}

export function recordPipelineMetric(m: PipelineMetric): void {
  getDb()
    .prepare(
      `INSERT INTO trade_pipeline_metrics
       (signature, direction, mint, source, outcome, reject_reason,
        sell_buffered, sell_buffer_ms, latency_risk_ms, latency_exec_ms, latency_total_ms,
        price_drift_pct, unsafe_parse, sell_on_sent_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.signature, m.direction, m.mint, m.source, m.outcome,
      m.reject_reason ?? null,
      m.sell_buffered ? 1 : 0, m.sell_buffer_ms,
      m.latency_risk_ms, m.latency_exec_ms, m.latency_total_ms,
      m.price_drift_pct ?? null,
      m.unsafe_parse ? 1 : 0,
      m.sell_on_sent_ms ?? 0,
    );
}

export function getUnsafeParseStats(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const total = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ?')
    .get(d) as { cnt: number };

  const unsafeTotal = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND unsafe_parse = 1')
    .get(d) as { cnt: number };

  const unsafeRejected = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND unsafe_parse = 1 AND reject_reason = 'UNSAFE_PARSE'`)
    .get(d) as { cnt: number };

  const unsafeCopied = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND unsafe_parse = 1 AND outcome = 'COPIED'`)
    .get(d) as { cnt: number };

  return {
    total: total.cnt,
    unsafeTotal: unsafeTotal.cnt,
    unsafePct: total.cnt > 0 ? +((unsafeTotal.cnt / total.cnt) * 100).toFixed(1) : 0,
    unsafeRejected: unsafeRejected.cnt,
    unsafeCopied: unsafeCopied.cnt,
  };
}

export function getUnroutableStats(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const total = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ?')
    .get(d) as { cnt: number };

  const unroutable = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND reject_reason = 'UNROUTABLE_TOKEN'`)
    .get(d) as { cnt: number };

  const topMints = getDb()
    .prepare(
      `SELECT mint, COUNT(*) as cnt FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND reject_reason = 'UNROUTABLE_TOKEN'
       GROUP BY mint ORDER BY cnt DESC LIMIT 10`,
    )
    .all(d) as Array<{ mint: string; cnt: number }>;

  return {
    count: unroutable.cnt,
    totalTrades: total.cnt,
    pct: total.cnt > 0 ? +((unroutable.cnt / total.cnt) * 100).toFixed(1) : 0,
    topMints,
  };
}

export function getSellOnSentStats(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const notConfirmed = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND reject_reason = 'POSITION_NOT_CONFIRMED'`)
    .get(d) as { cnt: number };

  const waitRows = getDb()
    .prepare(
      `SELECT sell_on_sent_ms FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND sell_on_sent_ms > 0`,
    )
    .all(d) as Array<{ sell_on_sent_ms: number }>;

  const avgWaitMs = waitRows.length > 0
    ? Math.round(waitRows.reduce((s, r) => s + r.sell_on_sent_ms, 0) / waitRows.length)
    : 0;

  return {
    notConfirmedCount: notConfirmed.cnt,
    sellsOnSent: waitRows.length,
    avgWaitMs,
  };
}

export function getPriceDriftStats(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const rejected = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND reject_reason = 'PRICE_DRIFT_TOO_HIGH'`,
    )
    .get(d) as { cnt: number };

  const drifts = getDb()
    .prepare(
      `SELECT price_drift_pct FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND direction = 'BUY' AND price_drift_pct IS NOT NULL
       ORDER BY price_drift_pct ASC`,
    )
    .all(d) as Array<{ price_drift_pct: number }>;

  if (drifts.length === 0) {
    return { rejectedCount: rejected.cnt, count: 0, min: null, median: null, p90: null, max: null };
  }

  const vals = drifts.map((r) => r.price_drift_pct);
  return {
    rejectedCount: rejected.cnt,
    count: vals.length,
    min: +vals[0].toFixed(2),
    median: +vals[Math.floor(vals.length * 0.5)].toFixed(2),
    p90: +vals[Math.min(Math.floor(vals.length * 0.9), vals.length - 1)].toFixed(2),
    max: +vals[vals.length - 1].toFixed(2),
  };
}

export function getPipelineMetricsSummary(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const total = getDb()
    .prepare('SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at) = ?')
    .get(d) as { cnt: number };

  const byOutcome = getDb()
    .prepare(
      `SELECT outcome, COUNT(*) as cnt FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? GROUP BY outcome`,
    )
    .all(d) as Array<{ outcome: string; cnt: number }>;

  const sellBuffered = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt, AVG(sell_buffer_ms) as avg_ms
       FROM trade_pipeline_metrics WHERE DATE(created_at) = ? AND sell_buffered = 1`,
    )
    .get(d) as { cnt: number; avg_ms: number | null };

  const latencies = getDb()
    .prepare(
      `SELECT latency_total_ms FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND outcome = 'COPIED' ORDER BY latency_total_ms ASC`,
    )
    .all(d) as Array<{ latency_total_ms: number }>;

  let p50 = 0, p90 = 0, p99 = 0;
  if (latencies.length > 0) {
    const vals = latencies.map((r) => r.latency_total_ms);
    p50 = vals[Math.floor(vals.length * 0.5)];
    p90 = vals[Math.floor(vals.length * 0.9)];
    p99 = vals[Math.min(Math.floor(vals.length * 0.99), vals.length - 1)];
  }

  const rejectReasons = getDb()
    .prepare(
      `SELECT reject_reason, COUNT(*) as cnt FROM trade_pipeline_metrics
       WHERE DATE(created_at) = ? AND outcome = 'REJECTED' GROUP BY reject_reason ORDER BY cnt DESC`,
    )
    .all(d) as Array<{ reject_reason: string; cnt: number }>;

  return {
    day: d,
    total: total.cnt,
    byOutcome: Object.fromEntries(byOutcome.map((r) => [r.outcome, r.cnt])),
    sellBuffered: { count: sellBuffered.cnt, avgMs: Math.round(sellBuffered.avg_ms ?? 0) },
    latency: { p50, p90, p99, count: latencies.length },
    rejectReasons,
  };
}

// ── Daily Summary ─────────────────────────────────

export function getDailySummary(day?: string) {
  const d = day ?? new Date().toISOString().slice(0, 10);

  const rows = getDb()
    .prepare(
      `SELECT direction, SUM(sol_amount) as total_sol, COUNT(*) as cnt
       FROM virtual_trades WHERE DATE(created_at) = ?
       GROUP BY direction`,
    )
    .all(d) as Array<{ direction: string; total_sol: number; cnt: number }>;

  const buyRow = rows.find((r) => r.direction === 'BUY');
  const sellRow = rows.find((r) => r.direction === 'SELL');

  const totalBuys = buyRow?.cnt ?? 0;
  const totalSells = sellRow?.cnt ?? 0;
  const totalBuyVol = buyRow?.total_sol ?? 0;
  const totalSellVol = sellRow?.total_sol ?? 0;

  const portfolio = getDb()
    .prepare('SELECT mint, total_spent, total_received FROM virtual_portfolio')
    .all() as Array<{ mint: string; total_spent: number; total_received: number }>;

  const winning = portfolio.filter((p) => p.total_received - p.total_spent > 0);
  const losing = portfolio.filter((p) => p.total_received - p.total_spent < 0);

  const bestTrade = getDb()
    .prepare(
      `SELECT mint, sol_amount FROM virtual_trades
       WHERE DATE(created_at) = ? AND direction = 'SELL'
       ORDER BY sol_amount DESC LIMIT 1`,
    )
    .get(d) as { mint: string; sol_amount: number } | undefined;

  return {
    day: d,
    totalTrades: totalBuys + totalSells,
    buys: totalBuys,
    sells: totalSells,
    totalBuyVolume: +totalBuyVol.toFixed(6),
    totalSellVolume: +totalSellVol.toFixed(6),
    netPnl: +(totalSellVol - totalBuyVol).toFixed(6),
    winningPositions: winning.length,
    losingPositions: losing.length,
    winRate: portfolio.length > 0 ? +((winning.length / portfolio.length) * 100).toFixed(1) : 0,
    bestTrade: bestTrade ? { mint: bestTrade.mint, sol: +bestTrade.sol_amount.toFixed(6) } : null,
    positions: portfolio.map((p) => ({
      mint: p.mint,
      invested: +p.total_spent.toFixed(6),
      received: +p.total_received.toFixed(6),
      pnl: +(p.total_received - p.total_spent).toFixed(6),
    })),
  };
}
