/**
 * C — Health Check Script
 * npm run health
 *
 * Vérifie que le bot est en bonne santé :
 *  1. Connexion DB + migrations
 *  2. Variables .env critiques présentes
 *  3. Ping /api/dashboard (si le bot tourne)
 *  4. Génère un rapport sample si aucune data
 */

import 'dotenv/config';
import { loadConfig } from '../config';
import { initDb } from '../db/sqlite';
import { runMigrations } from '../db/migrations';
import { getDb } from '../db/sqlite';
import { getPipelineMetricsSummary, getDailySummary } from '../db/repo';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function ok(msg: string) { console.log(`  ${GREEN}✔${RESET} ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}✘${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function info(msg: string) { console.log(`  ${CYAN}ℹ${RESET} ${msg}`); }

async function main(): Promise<void> {
  console.log(`\n${BOLD}═══ Bot Health Check ═══${RESET}\n`);

  let allOk = true;

  // ── 1. Config ──────────────────────────────────
  console.log(`${BOLD}1. Configuration${RESET}`);
  try {
    const config = loadConfig();
    ok(`Config chargée — mode: ${config.DRY_RUN ? 'SIMULATION' : 'LIVE'}`);
    ok(`Source wallet: ${config.SOURCE_WALLET.slice(0, 8)}...`);
    ok(`RPC URL: ${config.RPC_URL.replace(/api-key=.+/, 'api-key=***')}`);
    if (!config.JUPITER_API_KEY) {
      warn('JUPITER_API_KEY vide — les quotes échoueront en mode LIVE');
    } else {
      ok('JUPITER_API_KEY présent');
    }
    if (!config.TELEGRAM_BOT_TOKEN) {
      warn('TELEGRAM_BOT_TOKEN vide — pas de notifications');
    } else {
      ok('Telegram configuré');
    }
    if (config.EXTRA_RPC_URLS) {
      const count = config.EXTRA_RPC_URLS.split(',').filter(Boolean).length;
      ok(`${count} RPC endpoint(s) supplémentaire(s) configuré(s)`);
    }
  } catch (err) {
    fail(`Config invalide: ${(err as Error).message}`);
    allOk = false;
  }

  // ── 2. Base de données ────────────────────────
  console.log(`\n${BOLD}2. Base de données${RESET}`);
  try {
    initDb();
    ok('DB SQLite ouverte');

    const db = getDb();
    runMigrations(db as any);
    ok('Migrations appliquées');

    // Vérifier tables clés
    const tables = (db as any)
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name) as string[];

    const required = ['positions', 'source_trades', 'trade_pipeline_metrics', 'processed_events'];
    for (const t of required) {
      if (tables.includes(t)) {
        ok(`Table '${t}' présente`);
      } else {
        fail(`Table '${t}' MANQUANTE`);
        allOk = false;
      }
    }

    // Vérifier colonne status sur positions
    const cols = (db as any)
      .prepare(`PRAGMA table_info(positions)`)
      .all()
      .map((r: any) => r.name) as string[];
    if (cols.includes('status')) {
      ok("Colonne 'status' sur positions (state machine A1)");
    } else {
      warn("Colonne 'status' absente de positions — relancer le bot pour appliquer la migration");
    }
  } catch (err) {
    fail(`DB error: ${(err as Error).message}`);
    allOk = false;
  }

  // ── 3. Données du jour ──────────────────────
  console.log(`\n${BOLD}3. Données aujourd'hui${RESET}`);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const pipeline = getPipelineMetricsSummary(today);
    const summary = getDailySummary(today);

    if (pipeline.total === 0) {
      warn(`Aucune métrique pipeline pour ${today} — le bot a-t-il tourné aujourd'hui ?`);
    } else {
      const copied = pipeline.byOutcome['COPIED'] ?? 0;
      const failed = pipeline.byOutcome['FAILED'] ?? 0;
      const rejected = pipeline.byOutcome['REJECTED'] ?? 0;
      ok(`${pipeline.total} événements pipeline (${copied} copiés, ${rejected} rejetés, ${failed} échoués)`);
      info(`Latence P50/P90/P99: ${pipeline.latency.p50}ms / ${pipeline.latency.p90}ms / ${pipeline.latency.p99}ms`);
      if (pipeline.sellBuffered.count > 0) {
        info(`Sell buffering: ${pipeline.sellBuffered.count} fois (moy. ${pipeline.sellBuffered.avgMs}ms)`);
      }
    }

    if (summary.totalTrades === 0) {
      warn(`Aucun trade virtuel enregistré pour ${today}`);
    } else {
      ok(`${summary.totalTrades} trades virtuels (${summary.buys} BUY / ${summary.sells} SELL)`);
    }
  } catch (err) {
    warn(`Impossible de lire les métriques: ${(err as Error).message}`);
  }

  // ── 4. Ping dashboard (si bot actif) ─────────
  console.log(`\n${BOLD}4. Ping dashboard${RESET}`);
  try {
    const config = loadConfig();
    const url = `http://localhost:${config.PORT}/api/dashboard`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json() as any;
      ok(`Dashboard répond (uptime: ${data.uptime}s, mode: ${data.config?.mode})`);
      if (data.circuitBreaker?.open) {
        fail(`Circuit breaker OUVERT: ${data.circuitBreaker.openReason}`);
        allOk = false;
      } else {
        ok('Circuit breaker fermé');
      }
    } else {
      warn(`Dashboard répond avec status ${res.status}`);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('abort') || msg.includes('ECONNREFUSED') || msg.includes('fetch')) {
      warn('Bot non démarré (dashboard inaccessible) — normal si vous testez hors bot');
    } else {
      warn(`Dashboard inaccessible: ${msg}`);
    }
  }

  // ── Résumé ────────────────────────────────────
  console.log('\n' + '─'.repeat(40));
  if (allOk) {
    console.log(`${GREEN}${BOLD}✔ Health check passé${RESET}\n`);
  } else {
    console.log(`${RED}${BOLD}✘ Problèmes détectés — voir ci-dessus${RESET}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
