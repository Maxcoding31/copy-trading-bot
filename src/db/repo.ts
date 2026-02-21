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
      `INSERT INTO positions (mint, amount_raw, decimals, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(mint) DO UPDATE SET
         amount_raw = excluded.amount_raw,
         decimals   = excluded.decimals,
         updated_at = excluded.updated_at`,
    )
    .run(mint, amountRaw.toString(), decimals);
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

  // Update virtual portfolio
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
