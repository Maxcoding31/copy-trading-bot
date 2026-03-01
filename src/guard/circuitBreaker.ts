/**
 * A4 — Circuit Breaker
 *
 * Tracks trade outcomes in a rolling window and opens the circuit if:
 *   - FAILED trade rate exceeds CB_FAIL_RATE_PCT% in CB_FAIL_WINDOW_MINUTES
 *   - Latency P99 exceeds CB_LATENCY_P99_MS
 *   - "No position found" spikes above CB_NO_POSITION_SPIKE in the window
 *
 * When open, all trades are rejected with reason "CIRCUIT_BREAKER".
 * Auto-resets after CB_AUTO_RESET_MINUTES (0 = manual only).
 */

import { getConfig } from '../config';
import { notifyError } from '../notify/telegram';
import { logger } from '../utils/logger';

interface TradeEvent {
  ts: number;
  outcome: 'COPIED' | 'FAILED' | 'REJECTED' | 'NO_POSITION';
  latencyMs: number;
}

const _events: TradeEvent[] = [];
let _circuitOpen = false;
let _openedAt: number | null = null;
let _openReason = '';

export function recordOutcome(
  outcome: TradeEvent['outcome'],
  latencyMs: number,
): void {
  _events.push({ ts: Date.now(), outcome, latencyMs });
  // Keep only events within 2x the window to bound memory
  const config = getConfig();
  const cutoff = Date.now() - config.CB_FAIL_WINDOW_MINUTES * 2 * 60_000;
  while (_events.length > 0 && _events[0].ts < cutoff) _events.shift();
  _checkThresholds();
}

export function isCircuitOpen(): boolean {
  if (!_circuitOpen) return false;
  const config = getConfig();
  if (config.CB_AUTO_RESET_MINUTES > 0 && _openedAt) {
    const elapsed = (Date.now() - _openedAt) / 60_000;
    if (elapsed >= config.CB_AUTO_RESET_MINUTES) {
      resetCircuit('auto-reset after timeout');
      return false;
    }
  }
  return true;
}

export function resetCircuit(reason = 'manual reset'): void {
  if (_circuitOpen) {
    _circuitOpen = false;
    _openedAt = null;
    logger.info({ reason }, 'Circuit breaker CLOSED');
  }
}

export function getCircuitState() {
  const config = getConfig();
  const windowMs = config.CB_FAIL_WINDOW_MINUTES * 60_000;
  const cutoff = Date.now() - windowMs;
  const recent = _events.filter((e) => e.ts >= cutoff);

  const total = recent.length;
  const failed = recent.filter((e) => e.outcome === 'FAILED').length;
  const noPosition = recent.filter((e) => e.outcome === 'NO_POSITION').length;
  const copied = recent.filter((e) => e.outcome === 'COPIED').length;

  const latencies = recent.filter((e) => e.outcome === 'COPIED').map((e) => e.latencyMs).sort((a, b) => a - b);
  const p99 = latencies.length > 0
    ? latencies[Math.min(Math.floor(latencies.length * 0.99), latencies.length - 1)]
    : 0;

  const failRate = total > 0 ? (failed / total) * 100 : 0;

  return {
    open: _circuitOpen,
    openReason: _openedAt ? _openReason : null,
    openedAt: _openedAt ? new Date(_openedAt).toISOString() : null,
    window: {
      minutes: config.CB_FAIL_WINDOW_MINUTES,
      total,
      copied,
      failed,
      noPosition,
      failRatePct: +failRate.toFixed(1),
      latencyP99Ms: p99,
    },
    thresholds: {
      failRatePct: config.CB_FAIL_RATE_PCT,
      latencyP99Ms: config.CB_LATENCY_P99_MS,
      noPositionSpike: config.CB_NO_POSITION_SPIKE,
    },
  };
}

function _openCircuit(reason: string): void {
  if (_circuitOpen) return; // Already open
  _circuitOpen = true;
  _openedAt = Date.now();
  _openReason = reason;
  logger.error({ reason }, 'Circuit breaker OPENED — trading suspended');
  notifyError(`🚨 Circuit breaker ouvert: ${reason}. Trades suspendus.`);
}

function _checkThresholds(): void {
  if (_circuitOpen) return;
  const config = getConfig();
  const windowMs = config.CB_FAIL_WINDOW_MINUTES * 60_000;
  const cutoff = Date.now() - windowMs;
  const recent = _events.filter((e) => e.ts >= cutoff);

  if (recent.length < 3) return; // Not enough data

  // Check fail rate
  const failed = recent.filter((e) => e.outcome === 'FAILED').length;
  const failRate = (failed / recent.length) * 100;
  if (failRate > config.CB_FAIL_RATE_PCT) {
    _openCircuit(`Taux d'échec ${failRate.toFixed(0)}% > seuil ${config.CB_FAIL_RATE_PCT}%`);
    return;
  }

  // Check no-position spike
  const noPos = recent.filter((e) => e.outcome === 'NO_POSITION').length;
  if (config.CB_NO_POSITION_SPIKE > 0 && noPos >= config.CB_NO_POSITION_SPIKE) {
    _openCircuit(`Spike "no position found": ${noPos} en ${config.CB_FAIL_WINDOW_MINUTES}min`);
    return;
  }

  // Check P99 latency
  if (config.CB_LATENCY_P99_MS > 0) {
    const latencies = recent
      .filter((e) => e.outcome === 'COPIED')
      .map((e) => e.latencyMs)
      .sort((a, b) => a - b);
    if (latencies.length >= 5) {
      const p99 = latencies[Math.min(Math.floor(latencies.length * 0.99), latencies.length - 1)];
      if (p99 > config.CB_LATENCY_P99_MS) {
        _openCircuit(`Latence P99 ${p99}ms > seuil ${config.CB_LATENCY_P99_MS}ms`);
      }
    }
  }
}
