import express from 'express';
import path from 'path';
import { loadConfig, getConfig } from './config';
import { initDb, closeDb } from './db/sqlite';
import { getKeypair, getSharedConnection } from './trade/solana';
import { webhookRouter } from './webhook/handler';
import { startPollingMonitor } from './monitor/wsMonitor';
import { notifyStartup, notifyError } from './notify/telegram';
import {
  getVirtualPnL, getVirtualPortfolio, getDailySpent, getOpenPositionCount,
  getRecentSourceTrades, getRecentVirtualTrades,
} from './db/repo';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  initDb();
  const keypair = getKeypair();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Serve dashboard static files
  app.use(express.static(path.resolve(__dirname, '..', 'public')));

  // Rate limiting on webhook endpoint
  let reqCount = 0;
  setInterval(() => { reqCount = 0; }, 60_000);

  app.use('/webhook', (_req, res, next) => {
    if (++reqCount > 120) {
      logger.warn('Rate limit exceeded on /webhook');
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    logger.info({ method: _req.method, path: _req.path, ip: _req.ip }, 'Webhook request incoming');
    next();
  });

  // Health + status endpoint – accessible from browser to monitor the bot
  app.get('/health', (_req, res) => {
    const pnl = getVirtualPnL();
    const portfolio = getVirtualPortfolio();
    const openPositions = getOpenPositionCount();
    const dailySpent = getDailySpent();

    res.json({
      status: 'ok',
      mode: config.DRY_RUN ? 'SIMULATION' : 'LIVE',
      paused: config.PAUSE_TRADING,
      uptime: Math.round(process.uptime()),
      botWallet: keypair.publicKey.toBase58(),
      sourceWallet: config.SOURCE_WALLET,
      settings: {
        copyRatio: config.COPY_RATIO,
        maxSolPerTrade: config.MAX_SOL_PER_TRADE,
        maxSolPerDay: config.MAX_SOL_PER_DAY,
        maxOpenPositions: config.MAX_OPEN_POSITIONS,
        slippageBps: config.SLIPPAGE_BPS,
      },
      budget: {
        dailySpent: +dailySpent.toFixed(6),
        dailyLimit: config.MAX_SOL_PER_DAY,
        remaining: +(config.MAX_SOL_PER_DAY - dailySpent).toFixed(6),
      },
      positions: {
        openCount: openPositions,
        details: portfolio.map((p) => ({
          mint: p.mint,
          tokens: p.token_amount,
          invested: +p.total_spent.toFixed(6),
          received: +p.total_received.toFixed(6),
          pnl: +(p.total_received - p.total_spent).toFixed(6),
        })),
      },
      virtualPnL: {
        totalInvested: +pnl.totalSpent.toFixed(6),
        totalReceived: +pnl.totalReceived.toFixed(6),
        netPnL: +pnl.pnl.toFixed(6),
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Dashboard API – single endpoint with all data for the frontend
  app.get('/api/dashboard', (_req, res) => {
    const pnl = getVirtualPnL();
    const portfolio = getVirtualPortfolio();
    const openPositions = getOpenPositionCount();
    const dailySpent = getDailySpent();
    const startingBalance = config.VIRTUAL_STARTING_BALANCE;
    const currentBalance = startingBalance + pnl.pnl;
    const pnlPercent = startingBalance > 0 ? (pnl.pnl / startingBalance) * 100 : 0;

    res.json({
      wallet: {
        startingBalance,
        currentBalance: +currentBalance.toFixed(6),
        pnl: +pnl.pnl.toFixed(6),
        pnlPercent: +pnlPercent.toFixed(2),
        totalInvested: +pnl.totalSpent.toFixed(6),
        totalReceived: +pnl.totalReceived.toFixed(6),
      },
      config: {
        mode: config.DRY_RUN ? 'SIMULATION' : 'LIVE',
        paused: config.PAUSE_TRADING,
        copyRatio: config.COPY_RATIO,
        maxSolPerTrade: config.MAX_SOL_PER_TRADE,
        maxSolPerDay: config.MAX_SOL_PER_DAY,
        maxOpenPositions: config.MAX_OPEN_POSITIONS,
        slippageBps: config.SLIPPAGE_BPS,
        sourceWallet: config.SOURCE_WALLET,
        botWallet: keypair.publicKey.toBase58(),
      },
      budget: {
        dailySpent: +dailySpent.toFixed(6),
        dailyLimit: config.MAX_SOL_PER_DAY,
        remaining: +(config.MAX_SOL_PER_DAY - dailySpent).toFixed(6),
      },
      positions: {
        openCount: openPositions,
        maxPositions: config.MAX_OPEN_POSITIONS,
        details: portfolio.map((p) => ({
          mint: p.mint,
          tokens: p.token_amount,
          invested: +p.total_spent.toFixed(6),
          received: +p.total_received.toFixed(6),
          pnl: +(p.total_received - p.total_spent).toFixed(6),
        })),
      },
      sourceTrades: getRecentSourceTrades(100),
      botTrades: getRecentVirtualTrades(100),
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/webhook', webhookRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled Express error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        mode: config.DRY_RUN ? 'SIMULATION' : 'LIVE',
        sourceWallet: config.SOURCE_WALLET,
        botWallet: keypair.publicKey.toBase58(),
        copyRatio: config.COPY_RATIO,
        maxSolPerTrade: config.MAX_SOL_PER_TRADE,
        maxSolPerDay: config.MAX_SOL_PER_DAY,
      },
      'Copy-trading bot started',
    );
    notifyStartup(keypair.publicKey.toBase58(), config.DRY_RUN);

    // Start polling monitor for fast detection (~2-3s vs ~8s webhook)
    try {
      const connection = getSharedConnection();
      startPollingMonitor(connection);
    } catch (err) {
      logger.error({ err }, 'Failed to start polling monitor, relying on webhook only');
    }
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    server.close(() => {
      closeDb();
      logger.info('Server and database closed');
      process.exit(0);
    });
    setTimeout(() => { logger.warn('Forced shutdown'); process.exit(1); }, 10_000);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    notifyError(`Uncaught exception: ${err.message}`);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
    notifyError(`Unhandled rejection: ${String(reason)}`);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
