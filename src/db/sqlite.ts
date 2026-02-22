import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../utils/logger';
import { runMigrations } from './migrations';

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'bot.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized – call initDb() first');
  return _db;
}

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  const fs = require('fs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  logger.info({ path: DB_PATH }, 'SQLite database initialized');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('SQLite database closed');
  }
}

export function resetDb(): void {
  closeDb();
  const fs = require('fs');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  initDb();
  logger.info('Database reset complete');
}
