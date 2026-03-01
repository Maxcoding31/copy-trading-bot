/**
 * B — Performance Report HTML Generator
 *
 * Produces a self-contained HTML page with KPIs, alert signals,
 * and a "What to check" section.
 * Accessible at /report/:day  (e.g. /report/today or /report/2026-03-01).
 */

import { getPipelineMetricsSummary, getDailySummary, getDailyComparisonMetrics, getVirtualPnL, getVirtualCash, getPriceDriftStats, getUnsafeParseStats, getUnroutableStats, getSellOnSentStats } from '../db/repo';
import { getCircuitState } from '../guard/circuitBreaker';
import { getConfig } from '../config';

// ─────────────────────────────────────────────────

export function buildPerformanceReport(day: string): string {
  const cfg = getConfig();
  const pipeline = getPipelineMetricsSummary(day);
  const summary = getDailySummary(day);
  const comparison = getDailyComparisonMetrics(day);
  const circuit = getCircuitState();
  const driftStats = getPriceDriftStats(day);
  const pnl = getVirtualPnL();
  const cash = getVirtualCash();

  const unsafeStats = getUnsafeParseStats(day);
  const unroutableStats = getUnroutableStats(day);
  const sellOnSentStats = getSellOnSentStats(day);

  const mode = cfg.DRY_RUN ? 'SIMULATION' : 'LIVE';
  const totalDetected = pipeline.total;
  const copied = pipeline.byOutcome['COPIED'] ?? 0;
  const rejected = pipeline.byOutcome['REJECTED'] ?? 0;
  const failed = pipeline.byOutcome['FAILED'] ?? 0;
  const circuitBroken = pipeline.byOutcome['CIRCUIT_BREAKER'] ?? 0;
  const copyRate = totalDetected > 0 ? ((copied / totalDetected) * 100).toFixed(1) : '0';
  const failRate = totalDetected > 0 ? (((failed) / totalDetected) * 100).toFixed(1) : '0';

  // Source breakdown
  const sourceBreakdown = buildSourceBreakdown(day);

  // Latency p50/p90/p99
  const lat = pipeline.latency;
  const latOk = lat.count > 0;

  // Alerts
  const alerts = buildAlerts(pipeline, circuit, cfg);
  const whatToCheck = buildWhatToCheck(pipeline, circuit, cfg, failed, rejected, copied, totalDetected);

  // Top reject reasons
  const rejectRows = pipeline.rejectReasons.slice(0, 8).map((r) =>
    `<tr><td>${esc(r.reject_reason ?? 'Unknown')}</td><td class="num">${r.cnt}</td></tr>`,
  ).join('');

  const netPnl = pnl.pnl;
  const pnlClass = netPnl >= 0 ? 'pos' : 'neg';
  const pnlPct = cfg.VIRTUAL_STARTING_BALANCE > 0
    ? ((netPnl / cfg.VIRTUAL_STARTING_BALANCE) * 100).toFixed(2)
    : '0';

  const generatedAt = new Date().toLocaleString('fr-FR', { timeZone: 'UTC', hour12: false });
  const circuitBadge = circuit.open
    ? `<span class="badge badge-alert">🔴 CIRCUIT OUVERT</span>`
    : `<span class="badge badge-ok">🟢 Circuit OK</span>`;

  return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Performance Report — ${day}</title>
<style>
  :root{--bg:#0d1117;--surface:#161b22;--border:#30363d;--text:#e6edf3;--text2:#8b949e;
    --green:#3fb950;--red:#f85149;--yellow:#d29922;--accent:#58a6ff;--orange:#e3892b;
    --green-bg:rgba(63,185,80,.12);--red-bg:rgba(248,81,73,.12);--yellow-bg:rgba(210,153,34,.12);}
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;padding:0;}
  a{color:var(--accent);text-decoration:none;}a:hover{text-decoration:underline;}

  /* Header */
  .header{background:var(--surface);border-bottom:1px solid var(--border);padding:18px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
  .header h1{font-size:20px;font-weight:700;}
  .header-meta{font-size:12px;color:var(--text2);}
  .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;}
  .badge-ok{background:var(--green-bg);color:var(--green);}
  .badge-alert{background:var(--red-bg);color:var(--red);}
  .badge-sim{background:var(--yellow-bg);color:var(--yellow);}
  .badge-live{background:var(--green-bg);color:var(--green);}
  .header-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
  .btn{display:inline-block;padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;text-decoration:none;}
  .btn-primary{background:var(--accent);color:#fff;}
  .btn-outline{background:none;border:1px solid var(--border);color:var(--text2);}
  .btn:hover{opacity:.85;}

  /* KPI cards */
  .section{padding:24px 32px;}
  .section-title{font-size:16px;font-weight:700;margin-bottom:16px;color:var(--text);}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px;}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;text-align:center;}
  .kpi-label{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
  .kpi-value{font-size:30px;font-weight:800;line-height:1.1;}
  .kpi-sub{font-size:11px;color:var(--text2);margin-top:6px;}
  .pos{color:var(--green);}
  .neg{color:var(--red);}
  .warn{color:var(--yellow);}
  .num{text-align:right;}

  /* Alerts */
  .alerts{margin-bottom:24px;}
  .alert{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;border-radius:8px;margin-bottom:8px;font-size:13px;}
  .alert-crit{background:var(--red-bg);border:1px solid rgba(248,81,73,.3);}
  .alert-warn{background:var(--yellow-bg);border:1px solid rgba(210,153,34,.3);}
  .alert-ok{background:var(--green-bg);border:1px solid rgba(63,185,80,.3);}
  .alert-icon{font-size:16px;flex-shrink:0;margin-top:1px;}

  /* What to check */
  .check-list{list-style:none;display:flex;flex-direction:column;gap:10px;}
  .check-item{display:flex;align-items:flex-start;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;}
  .check-num{font-size:18px;font-weight:800;color:var(--accent);flex-shrink:0;width:24px;}
  .check-text{font-size:13px;line-height:1.5;}

  /* Table */
  .table-wrap{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;}
  th{text-align:left;font-size:11px;color:var(--text2);text-transform:uppercase;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface);}
  td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px;}
  tr:last-child td{border-bottom:none;}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:16px;}
  .panel-header{padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;}

  /* Latency bars */
  .lat-bar{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
  .lat-label{font-size:12px;color:var(--text2);width:36px;}
  .lat-track{flex:1;height:8px;background:var(--border);border-radius:4px;overflow:hidden;}
  .lat-fill{height:100%;border-radius:4px;background:var(--accent);}
  .lat-val{font-size:12px;font-weight:600;width:70px;text-align:right;}

  footer{padding:20px 32px;font-size:11px;color:var(--text2);border-top:1px solid var(--border);margin-top:8px;}
  @media(max-width:700px){.section{padding:16px;}.kpi-value{font-size:22px;}}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>📊 Performance Report — ${day}</h1>
    <div class="header-meta">Mode: <span class="badge badge-${mode.toLowerCase()}">${mode}</span> &nbsp;•&nbsp; ${circuitBadge} &nbsp;•&nbsp; Généré le ${generatedAt} UTC</div>
  </div>
  <div class="header-actions">
    <a class="btn btn-outline" href="/report/today" style="font-size:12px;">Aujourd'hui</a>
    <a class="btn btn-outline" href="/api/report/export/json/${day}" download style="font-size:12px;">⬇ JSON</a>
    <a class="btn btn-primary" href="/" style="font-size:12px;">← Dashboard</a>
  </div>
</div>

<div class="section">
  <div class="section-title">📈 KPIs du jour</div>
  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Détectés</div>
      <div class="kpi-value">${totalDetected}</div>
      <div class="kpi-sub">trades vus</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Copiés</div>
      <div class="kpi-value pos">${copied}</div>
      <div class="kpi-sub">${copyRate}% du total</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Rejetés</div>
      <div class="kpi-value warn">${rejected}</div>
      <div class="kpi-sub">par règles de risque</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Échoués</div>
      <div class="kpi-value ${failed > 0 ? 'neg' : ''}">${failed}</div>
      <div class="kpi-sub">${failRate}% du total</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Sell Buffered</div>
      <div class="kpi-value">${pipeline.sellBuffered.count}</div>
      <div class="kpi-sub">moy. ${pipeline.sellBuffered.avgMs}ms</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Circuit Brkr</div>
      <div class="kpi-value ${circuitBroken > 0 ? 'neg' : ''}">${circuitBroken}</div>
      <div class="kpi-sub">trades bloqués</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">PnL Net</div>
      <div class="kpi-value ${pnlClass}">${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)}</div>
      <div class="kpi-sub">SOL (${pnlPct}%)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Cash dispo</div>
      <div class="kpi-value">${cash.toFixed(3)}</div>
      <div class="kpi-sub">SOL en wallet</div>
    </div>
  </div>

  <!-- Latency -->
  <div class="panel">
    <div class="panel-header">⚡ Latence pipeline (trades copiés uniquement)</div>
    <div style="padding:16px;">
      ${latOk ? `
      <div class="lat-bar">
        <span class="lat-label">P50</span>
        <div class="lat-track"><div class="lat-fill" style="width:${Math.min(lat.p50/150,100)}%"></div></div>
        <span class="lat-val">${lat.p50}ms</span>
      </div>
      <div class="lat-bar">
        <span class="lat-label">P90</span>
        <div class="lat-track"><div class="lat-fill" style="width:${Math.min(lat.p90/150,100)}%;background:${lat.p90>8000?'var(--yellow)':'var(--accent)'}"></div></div>
        <span class="lat-val ${lat.p90 > 8000 ? 'warn' : ''}">${lat.p90}ms</span>
      </div>
      <div class="lat-bar">
        <span class="lat-label">P99</span>
        <div class="lat-track"><div class="lat-fill" style="width:${Math.min(lat.p99/150,100)}%;background:${lat.p99>12000?'var(--red)':'var(--accent)'}"></div></div>
        <span class="lat-val ${lat.p99 > 12000 ? 'neg' : lat.p99 > 8000 ? 'warn' : ''}">${lat.p99}ms</span>
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:8px;">Basé sur ${lat.count} trades copiés</div>
      ` : `<div style="color:var(--text2);font-size:13px;">Aucun trade copié aujourd'hui — pas de données de latence.</div>`}
    </div>
  </div>

  <!-- Source breakdown -->
  ${sourceBreakdown}
</div>

<!-- Alerts -->
<div class="section" style="padding-top:0;">
  <div class="section-title">🚨 Signaux d'alerte</div>
  <div class="alerts">
    ${alerts}
  </div>
</div>

<!-- What to check -->
<div class="section" style="padding-top:0;">
  <div class="section-title">✅ Que vérifier (5 points clés)</div>
  <ul class="check-list">
    ${whatToCheck}
  </ul>
</div>

<!-- Reject reasons -->
${rejectRows ? `
<div class="section" style="padding-top:0;">
  <div class="section-title">❌ Raisons de rejet</div>
  <div class="panel">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Raison</th><th>Nb</th></tr></thead>
        <tbody>${rejectRows}</tbody>
      </table>
    </div>
  </div>
</div>` : ''}

<!-- Price Drift Guard -->
${buildDriftSection(driftStats, cfg)}

<!-- Unsafe parse section -->
${buildUnsafeParseSection(unsafeStats, cfg)}

<!-- Unroutable tokens section -->
${buildUnroutableSection(unroutableStats)}

<!-- Slippage metrics -->
${comparison ? `
<div class="section" style="padding-top:0;">
  <div class="section-title">📐 Slippage exécution (LIVE uniquement)</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));">
    <div class="kpi"><div class="kpi-label">Moy SOL slip.</div><div class="kpi-value ${comparison.avgSolSlippagePct>2?'warn':''}">${comparison.avgSolSlippagePct}%</div></div>
    <div class="kpi"><div class="kpi-label">P95 SOL slip.</div><div class="kpi-value ${comparison.p95SolSlippagePct>5?'neg':comparison.p95SolSlippagePct>2?'warn':''}">${comparison.p95SolSlippagePct}%</div></div>
    <div class="kpi"><div class="kpi-label">Max SOL slip.</div><div class="kpi-value neg">${comparison.maxSolSlippagePct}%</div></div>
  </div>
</div>` : ''}

<!-- Bot stability synthesis -->
${buildStabilitySection(pipeline, unsafeStats, unroutableStats, sellOnSentStats, cfg)}

<footer>
  Rapport généré par le bot Copy-Trading Solana • ${day} • <a href="/api/report/export/json/${day}">Télécharger JSON</a>
</footer>

</body>
</html>`;
}

// ── Helper: source breakdown ───────────────────────

function buildSourceBreakdown(day: string): string {
  // We query the pipeline metrics table by source
  try {
    const { getDb } = require('../db/sqlite');
    const rows = getDb()
      .prepare(
        `SELECT source, COUNT(*) as cnt FROM trade_pipeline_metrics
         WHERE DATE(created_at) = ? GROUP BY source ORDER BY cnt DESC`,
      )
      .all(day) as Array<{ source: string; cnt: number }>;

    if (rows.length === 0) return '';

    const total = rows.reduce((s, r) => s + r.cnt, 0);
    const bars = rows.map((r) => {
      const pct = total > 0 ? Math.round((r.cnt / total) * 100) : 0;
      const color = r.source === 'webhook' ? 'var(--green)' : r.source === 'ws' ? 'var(--accent)' : 'var(--yellow)';
      return `
        <div class="lat-bar">
          <span class="lat-label" style="width:90px;font-size:12px;">${esc(r.source)}</span>
          <div class="lat-track"><div class="lat-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="lat-val">${r.cnt} (${pct}%)</span>
        </div>`;
    }).join('');

    return `
      <div class="panel">
        <div class="panel-header">📡 Source de détection</div>
        <div style="padding:16px;">${bars}</div>
      </div>`;
  } catch {
    return '';
  }
}

// ── Helper: alert signals ──────────────────────────

function buildAlerts(
  pipeline: ReturnType<typeof getPipelineMetricsSummary>,
  circuit: ReturnType<typeof getCircuitState>,
  cfg: ReturnType<typeof getConfig>,
): string {
  const items: string[] = [];

  // Circuit breaker
  if (circuit.open) {
    items.push(alert('crit', '🔴', `Circuit breaker OUVERT — raison: <strong>${esc(circuit.openReason ?? '')}</strong>. Utilisez <code>POST /api/circuit-breaker/reset</code> pour le réinitialiser.`));
  } else {
    items.push(alert('ok', '🟢', 'Circuit breaker fermé — trading actif.'));
  }

  // No position spikes
  const noPos = pipeline.rejectReasons.find((r) => (r.reject_reason ?? '').includes('No position found'));
  if (noPos && noPos.cnt >= cfg.CB_NO_POSITION_SPIKE) {
    items.push(alert('crit', '❗', `<strong>${noPos.cnt} rejets "No position found"</strong> aujourd'hui — seuil: ${cfg.CB_NO_POSITION_SPIKE}. Vérifier ordre des événements BUY/SELL.`));
  } else if (noPos && noPos.cnt > 0) {
    items.push(alert('warn', '⚠️', `${noPos.cnt} rejet(s) "No position found" — sous le seuil d'alerte (${cfg.CB_NO_POSITION_SPIKE}).`));
  }

  // Failed trades
  const failed = pipeline.byOutcome['FAILED'] ?? 0;
  const total = pipeline.total;
  const failRate = total > 0 ? (failed / total) * 100 : 0;
  if (failRate > cfg.CB_FAIL_RATE_PCT) {
    items.push(alert('crit', '🔴', `Taux d'échec <strong>${failRate.toFixed(0)}%</strong> dépasse le seuil ${cfg.CB_FAIL_RATE_PCT}%.`));
  } else if (failed > 0) {
    items.push(alert('warn', '⚠️', `${failed} trade(s) échoués (${failRate.toFixed(1)}%).`));
  }

  // Latency
  const lat = pipeline.latency;
  if (lat.count > 0 && lat.p99 > cfg.CB_LATENCY_P99_MS) {
    items.push(alert('crit', '⏱️', `Latence P99 <strong>${lat.p99}ms</strong> dépasse le seuil ${cfg.CB_LATENCY_P99_MS}ms.`));
  } else if (lat.count > 0 && lat.p90 > 8000) {
    items.push(alert('warn', '⏱️', `Latence P90 <strong>${lat.p90}ms</strong> — taux d'exécution au bon prix potentiellement impacté.`));
  }

  // WS health
  try {
    const { getDb } = require('../db/sqlite');
    const today = new Date().toISOString().slice(0, 10);
    const wsRow = getDb()
      .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at)=? AND source='ws'`)
      .get(today) as { cnt: number };
    const pollRow = getDb()
      .prepare(`SELECT COUNT(*) as cnt FROM trade_pipeline_metrics WHERE DATE(created_at)=? AND source='poll'`)
      .get(today) as { cnt: number };
    const wsCnt = wsRow.cnt, pollCnt = pollRow.cnt;
    if (pollCnt > 0 && wsCnt === 0) {
      items.push(alert('warn', '📡', `Tous les trades détectés via <strong>polling</strong> uniquement — le WebSocket semble inactif.`));
    } else if (pollCnt > wsCnt * 2) {
      items.push(alert('warn', '📡', `Plus de trades via polling (${pollCnt}) que WebSocket (${wsCnt}) — vérifier la connexion WS.`));
    } else {
      items.push(alert('ok', '📡', `WebSocket actif (${wsCnt} WS / ${pollCnt} poll aujourd'hui).`));
    }
  } catch { /* skip */ }

  return items.join('');
}

function alert(level: 'crit' | 'warn' | 'ok', icon: string, text: string): string {
  const cls = level === 'crit' ? 'alert-crit' : level === 'warn' ? 'alert-warn' : 'alert-ok';
  return `<div class="alert ${cls}"><span class="alert-icon">${icon}</span><span>${text}</span></div>`;
}

// ── Helper: what to check ──────────────────────────

function buildWhatToCheck(
  pipeline: ReturnType<typeof getPipelineMetricsSummary>,
  circuit: ReturnType<typeof getCircuitState>,
  cfg: ReturnType<typeof getConfig>,
  failed: number,
  rejected: number,
  copied: number,
  total: number,
): string {
  const items: string[] = [];
  const copyRate = total > 0 ? (copied / total) * 100 : 0;
  const noPos = pipeline.rejectReasons.find((r) => (r.reject_reason ?? '').includes('No position found'));
  const lat = pipeline.latency;

  // 1. Taux de copie
  if (copyRate >= 80) {
    items.push(check('✅', `<strong>Taux de copie : ${copyRate.toFixed(0)}%</strong> — excellent. Le bot copie la grande majorité des trades du wallet source.`));
  } else if (copyRate >= 50) {
    items.push(check('⚠️', `<strong>Taux de copie : ${copyRate.toFixed(0)}%</strong> — moyen. Regarder les raisons de rejet ci-dessous pour trouver ce qui bloque.`));
  } else {
    items.push(check('❌', `<strong>Taux de copie : ${copyRate.toFixed(0)}%</strong> — faible. Priorité : diagnostiquer pourquoi ${rejected + failed} trades ne sont pas copiés.`));
  }

  // 2. No position found
  if (noPos && noPos.cnt > 0) {
    items.push(check('🔎', `<strong>${noPos.cnt} "No position found"</strong> — des ventes ont été détectées avant que le bot ait ouvert la position correspondante. Si ce chiffre est > ${cfg.CB_NO_POSITION_SPIKE}, vérifier l'ordre d'arrivée des événements.`));
  } else {
    items.push(check('✅', `<strong>Aucun "No position found"</strong> — la gestion BUY/SELL est cohérente aujourd'hui.`));
  }

  // 3. Latence
  if (lat.count > 0) {
    if (lat.p99 > 12000) {
      items.push(check('⏱️', `<strong>Latence P99 : ${lat.p99}ms</strong> — trop élevée. Le bot arrive tard sur les trades, ce qui réduit le profit potentiel. Envisager des RPC supplémentaires (EXTRA_RPC_URLS).`));
    } else if (lat.p90 > 5000) {
      items.push(check('⏱️', `<strong>Latence P90 : ${lat.p90}ms</strong> — acceptable mais à surveiller. Idéalement < 5000ms.`));
    } else {
      items.push(check('✅', `<strong>Latence P90 : ${lat.p90}ms</strong> — bonne performance de détection.`));
    }
  } else {
    items.push(check('ℹ️', `<strong>Pas de données de latence</strong> — aucun trade copié aujourd'hui ou premier jour de suivi.`));
  }

  // 4. Circuit breaker / trades failed
  if (circuit.open) {
    items.push(check('🚨', `<strong>Circuit breaker OUVERT</strong> — raison: ${esc(circuit.openReason ?? '')}. Vérifier les logs, corriger le problème, puis réinitialiser via le dashboard ou <code>POST /api/circuit-breaker/reset</code>.`));
  } else if (failed > 0) {
    items.push(check('🔎', `<strong>${failed} trade(s) échoués</strong> — consulter les logs pour la raison (solde insuffisant, RPC timeout, Jupiter refus). Le circuit breaker n'a pas déclenché.`));
  } else {
    items.push(check('✅', `<strong>Aucun trade échoué</strong> — exécution fiable aujourd'hui.`));
  }

  // 5. Sell buffering
  if (pipeline.sellBuffered.count > 0) {
    items.push(check('ℹ️', `<strong>${pipeline.sellBuffered.count} vente(s) bufferisée(s)</strong> (moy. ${pipeline.sellBuffered.avgMs}ms de délai) — le mécanisme anti sell-before-buy a fonctionné. Si ce nombre est élevé, les trades du wallet source arrivent souvent dans le mauvais ordre.`));
  } else {
    items.push(check('✅', `<strong>Aucun sell buffering</strong> — l'ordre des événements BUY/SELL est correct aujourd'hui.`));
  }

  return items.map((i, idx) => `<li class="check-item"><span class="check-num">${idx + 1}</span><span class="check-text">${i}</span></li>`).join('');
}

function check(icon: string, text: string): string {
  return `${icon} ${text}`;
}

// ── Helper: price drift section ───────────────────

function buildDriftSection(
  drift: ReturnType<typeof getPriceDriftStats>,
  cfg: ReturnType<typeof getConfig>,
): string {
  const threshold = (cfg.MAX_PRICE_DRIFT_PCT * 100).toFixed(0);
  const enabled = cfg.MAX_PRICE_DRIFT_PCT > 0;

  const statusBadge = enabled
    ? `<span class="badge badge-ok">Actif — seuil ${threshold}%</span>`
    : `<span class="badge" style="background:var(--yellow-bg);color:var(--yellow)">Désactivé (MAX_PRICE_DRIFT_PCT=0)</span>`;

  // Distribution bars (relative to max, capped at threshold for visual reference)
  const barMax = Math.max(drift.max ?? 0, cfg.MAX_PRICE_DRIFT_PCT * 100, 1);

  const distRows = drift.count > 0 ? `
    <div style="padding:16px;">
      ${buildDriftBar('Min', drift.min ?? 0, barMax, cfg.MAX_PRICE_DRIFT_PCT * 100)}
      ${buildDriftBar('Médiane', drift.median ?? 0, barMax, cfg.MAX_PRICE_DRIFT_PCT * 100)}
      ${buildDriftBar('P90', drift.p90 ?? 0, barMax, cfg.MAX_PRICE_DRIFT_PCT * 100)}
      ${buildDriftBar('Max', drift.max ?? 0, barMax, cfg.MAX_PRICE_DRIFT_PCT * 100)}
      <div style="font-size:11px;color:var(--text2);margin-top:8px;">
        Basé sur ${drift.count} trades BUY avec prix calculable.
        Ligne rouge = seuil ${threshold}%.
      </div>
    </div>` : `<div style="padding:16px;color:var(--text2);font-size:13px;">
      Aucun trade BUY avec drift calculable aujourd'hui.
    </div>`;

  return `
<div class="section" style="padding-top:0;">
  <div class="section-title">📉 Price Drift Guard ${statusBadge}</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:16px;">
    <div class="kpi">
      <div class="kpi-label">Rejetés drift</div>
      <div class="kpi-value ${drift.rejectedCount > 0 ? 'warn' : ''}">${drift.rejectedCount}</div>
      <div class="kpi-sub">PRICE_DRIFT_TOO_HIGH</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">BUY mesurés</div>
      <div class="kpi-value">${drift.count}</div>
      <div class="kpi-sub">drift calculable</div>
    </div>
    ${drift.count > 0 ? `
    <div class="kpi">
      <div class="kpi-label">Drift médian</div>
      <div class="kpi-value ${(drift.median ?? 0) > cfg.MAX_PRICE_DRIFT_PCT * 100 ? 'neg' : ''}">${drift.median ?? 0}%</div>
      <div class="kpi-sub">hausse prix source→bot</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Drift P90</div>
      <div class="kpi-value ${(drift.p90 ?? 0) > cfg.MAX_PRICE_DRIFT_PCT * 100 ? 'neg' : (drift.p90 ?? 0) > cfg.MAX_PRICE_DRIFT_PCT * 50 ? 'warn' : ''}">${drift.p90 ?? 0}%</div>
      <div class="kpi-sub">seuil: ${threshold}%</div>
    </div>` : ''}
  </div>
  <div class="panel">
    <div class="panel-header">Distribution des drifts observés (BUY copiés + rejetés)</div>
    ${distRows}
  </div>
</div>`;
}

function buildDriftBar(label: string, value: number, barMax: number, threshold: number): string {
  const fillPct = Math.min((value / barMax) * 100, 100);
  const thresholdPct = Math.min((threshold / barMax) * 100, 100);
  const color = value > threshold ? 'var(--red)' : value > threshold * 0.7 ? 'var(--yellow)' : 'var(--green)';
  return `
    <div class="lat-bar" style="position:relative;">
      <span class="lat-label" style="width:60px;font-size:12px;">${label}</span>
      <div class="lat-track" style="flex:1;position:relative;">
        <div class="lat-fill" style="width:${fillPct}%;background:${color}"></div>
        <div style="position:absolute;top:0;left:${thresholdPct}%;width:2px;height:100%;background:var(--red);opacity:.6;"></div>
      </div>
      <span class="lat-val" style="${value > threshold ? 'color:var(--red)' : ''}">${value.toFixed(1)}%</span>
    </div>`;
}

// ── Helper: unsafe parse section ──────────────────

function buildUnsafeParseSection(
  stats: ReturnType<typeof getUnsafeParseStats>,
  cfg: ReturnType<typeof getConfig>,
): string {
  const allowedText = cfg.ALLOW_UNSAFE_PARSE_TRADES
    ? 'autorisés <code style="font-size:11px;">(ALLOW_UNSAFE_PARSE_TRADES=true)</code>'
    : 'bloqués <code style="font-size:11px;">(ALLOW_UNSAFE_PARSE_TRADES=false)</code>';
  const driftText = cfg.DISABLE_DRIFT_GUARD_ON_UNSAFE_PARSE
    ? 'Drift Guard ignoré pour ces trades <code style="font-size:11px;">(DISABLE_DRIFT_GUARD_ON_UNSAFE_PARSE=true)</code>'
    : 'Drift Guard appliqué normalement';

  const highBadge = stats.unsafePct > 20
    ? `<span class="badge badge-alert" style="margin-left:8px;">Élevé</span>` : '';

  return `
<div class="section" style="padding-top:0;">
  <div class="section-title">⚠️ Trades unsafe_parse ${highBadge}</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px;">
    <div class="kpi">
      <div class="kpi-label">Total unsafe</div>
      <div class="kpi-value ${stats.unsafeTotal > 0 ? 'warn' : ''}">${stats.unsafeTotal}</div>
      <div class="kpi-sub">${stats.unsafePct}% du total (${stats.total} trades)</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Rejetés UNSAFE</div>
      <div class="kpi-value ${stats.unsafeRejected > 0 ? 'neg' : ''}">${stats.unsafeRejected}</div>
      <div class="kpi-sub">raison UNSAFE_PARSE</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Copiés unsafe</div>
      <div class="kpi-value">${stats.unsafeCopied}</div>
      <div class="kpi-sub">exécutés malgré le flag</div>
    </div>
  </div>
  <div style="font-size:12px;color:var(--text2);padding:0 4px;line-height:1.6;">
    Trades ${allowedText}. ${driftText}.<br>
    Les trades <em>unsafe_parse</em> utilisent des décimales approximées (6 par défaut) — le montant en tokens peut être imprécis pour les tokens non-Pump.fun.
  </div>
</div>`;
}

// ── Helper: unroutable tokens section ─────────────

function buildUnroutableSection(
  stats: ReturnType<typeof getUnroutableStats>,
): string {
  if (stats.count === 0) {
    return `
<div class="section" style="padding-top:0;">
  <div class="section-title">🔍 Tokens non-routables (UNROUTABLE_TOKEN)</div>
  <div class="alert alert-ok"><span class="alert-icon">✅</span><span>Aucun token non-routable aujourd'hui.</span></div>
</div>`;
  }

  const topRows = stats.topMints.map((r) =>
    `<tr><td style="font-family:monospace;font-size:11px;">${esc(r.mint)}</td><td class="num">${r.cnt}</td></tr>`,
  ).join('');

  const suggestion = stats.pct > 15
    ? `⚠️ <strong>Taux élevé (${stats.pct}%)</strong> — vérifier que <code>RESTRICT_INTERMEDIATE_TOKENS=false</code> (par défaut) et envisager d'augmenter <code>SLIPPAGE_BPS</code> pour les micro-caps à faible liquidité.`
    : `Taux de ${stats.pct}% — normal pour les micro-caps avec faible liquidité sur Jupiter.`;

  return `
<div class="section" style="padding-top:0;">
  <div class="section-title">🔍 Tokens non-routables (UNROUTABLE_TOKEN)</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px;">
    <div class="kpi">
      <div class="kpi-label">UNROUTABLE</div>
      <div class="kpi-value ${stats.count > 0 ? 'warn' : ''}">${stats.count}</div>
      <div class="kpi-sub">${stats.pct}% du total</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Mints distincts</div>
      <div class="kpi-value">${stats.topMints.length}</div>
      <div class="kpi-sub">top ${stats.topMints.length} listés</div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-header">Top mints sans route Jupiter</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Mint</th><th>Nb</th></tr></thead>
        <tbody>${topRows}</tbody>
      </table>
    </div>
  </div>
  <div style="font-size:12px;color:var(--text2);padding:4px 0;">${suggestion}</div>
</div>`;
}

// ── Helper: bot stability synthesis ───────────────

type TrafficLight = 'green' | 'yellow' | 'red';

function tl(status: TrafficLight): string {
  return status === 'green' ? '🟢' : status === 'yellow' ? '🟡' : '🔴';
}

function buildStabilitySection(
  pipeline: ReturnType<typeof getPipelineMetricsSummary>,
  unsafeStats: ReturnType<typeof getUnsafeParseStats>,
  unroutableStats: ReturnType<typeof getUnroutableStats>,
  sellOnSentStats: ReturnType<typeof getSellOnSentStats>,
  cfg: ReturnType<typeof getConfig>,
): string {
  const lat = pipeline.latency;
  const total = pipeline.total;
  const failed = pipeline.byOutcome['FAILED'] ?? 0;
  const failRate = total > 0 ? (failed / total) * 100 : 0;
  const notConfirmedPct = total > 0 ? (sellOnSentStats.notConfirmedCount / total) * 100 : 0;

  const p99Status: TrafficLight = !lat.count ? 'green'
    : lat.p99 > cfg.CB_LATENCY_P99_MS ? 'red'
    : lat.p99 > 8000 ? 'yellow' : 'green';

  const failStatus: TrafficLight = failRate > 15 ? 'red' : failRate > 5 ? 'yellow' : 'green';
  const unsafeStatus: TrafficLight = unsafeStats.unsafePct > 30 ? 'red' : unsafeStats.unsafePct > 10 ? 'yellow' : 'green';
  const unroutableStatus: TrafficLight = unroutableStats.pct > 15 ? 'red' : unroutableStats.pct > 5 ? 'yellow' : 'green';
  const notConfirmedStatus: TrafficLight = notConfirmedPct > 5 ? 'red' : notConfirmedPct > 0 ? 'yellow' : 'green';

  const statuses = [p99Status, failStatus, unsafeStatus, unroutableStatus, notConfirmedStatus];
  const overallStatus: TrafficLight = statuses.includes('red') ? 'red' : statuses.includes('yellow') ? 'yellow' : 'green';
  const overallText = overallStatus === 'green' ? 'Bot en bonne santé' : overallStatus === 'yellow' ? 'À surveiller' : 'Problèmes détectés';

  const rows: Array<{ label: string; value: string; status: TrafficLight; detail: string }> = [
    {
      label: 'Latence P99',
      value: lat.count > 0 ? `${lat.p99}ms` : 'N/A',
      status: p99Status,
      detail: `Seuil: ${cfg.CB_LATENCY_P99_MS}ms — basé sur ${lat.count} trades copiés`,
    },
    {
      label: 'Taux d\'échec',
      value: `${failRate.toFixed(1)}%`,
      status: failStatus,
      detail: `${failed} trades échoués sur ${total} — seuil alerte: 5%`,
    },
    {
      label: 'Unsafe parse',
      value: `${unsafeStats.unsafePct}%`,
      status: unsafeStatus,
      detail: `${unsafeStats.unsafeTotal} trades avec décimales approximées — seuil alerte: 10%`,
    },
    {
      label: 'UNROUTABLE',
      value: `${unroutableStats.pct}%`,
      status: unroutableStatus,
      detail: `${unroutableStats.count} tokens sans route Jupiter — seuil alerte: 5%`,
    },
    {
      label: 'Non confirmés',
      value: `${notConfirmedPct.toFixed(1)}%`,
      status: notConfirmedStatus,
      detail: `${sellOnSentStats.notConfirmedCount} SELLs rejetés POSITION_NOT_CONFIRMED — seuil alerte: >0%`,
    },
  ];

  const tableRows = rows.map((r) => `
    <tr>
      <td>${tl(r.status)} ${esc(r.label)}</td>
      <td class="num" style="${r.status === 'red' ? 'color:var(--red)' : r.status === 'yellow' ? 'color:var(--yellow)' : 'color:var(--green)'}">${esc(r.value)}</td>
      <td style="font-size:12px;color:var(--text2);">${esc(r.detail)}</td>
    </tr>`).join('');

  return `
<div class="section" style="padding-top:0;">
  <div class="section-title">🛡️ Stabilité du bot &nbsp; ${tl(overallStatus)} <span style="font-weight:400;font-size:14px;color:var(--text2);">${esc(overallText)}</span></div>
  <div class="panel">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Indicateur</th><th style="text-align:right;">Valeur</th><th>Détail</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>
</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
