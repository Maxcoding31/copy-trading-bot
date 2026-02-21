import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS processed_events (
    signature   TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS positions (
    mint        TEXT PRIMARY KEY,
    amount_raw  TEXT NOT NULL DEFAULT '0',
    decimals    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS budgets (
    day        TEXT PRIMARY KEY,
    spent_sol  REAL NOT NULL DEFAULT 0
  );`,

  `CREATE TABLE IF NOT EXISTS token_cooldowns (
    mint          TEXT PRIMARY KEY,
    last_trade_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS virtual_trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    signature    TEXT NOT NULL,
    direction    TEXT NOT NULL,
    mint         TEXT NOT NULL,
    sol_amount   REAL NOT NULL,
    token_amount TEXT NOT NULL,
    token_price  REAL NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS virtual_portfolio (
    mint         TEXT PRIMARY KEY,
    token_amount TEXT NOT NULL DEFAULT '0',
    avg_buy_sol  REAL NOT NULL DEFAULT 0,
    total_spent  REAL NOT NULL DEFAULT 0,
    total_received REAL NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );`,

  `CREATE TABLE IF NOT EXISTS source_trades (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    signature      TEXT NOT NULL,
    direction      TEXT NOT NULL,
    mint           TEXT NOT NULL,
    sol_amount     REAL NOT NULL,
    token_amount   TEXT NOT NULL DEFAULT '0',
    bot_action     TEXT NOT NULL DEFAULT 'DETECTED',
    bot_sol_amount REAL NOT NULL DEFAULT 0,
    reject_reason  TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );`,
];

export function runMigrations(db: Database.Database): void {
  db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  })();
  logger.info('Database migrations applied');
}
