import express from 'express';
import fs from 'fs';
import path from 'path';
import { loadConfig, getConfig, reloadConfig } from './config';
import { initDb, closeDb, resetDb } from './db/sqlite';
import { getKeypair, reloadKeypair, getSharedConnection } from './trade/solana';
import { webhookRouter } from './webhook/handler';
import { startPollingMonitor, stopPollingMonitor } from './monitor/wsMonitor';
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

  // ── Settings API ─────────────────────────────────
  app.post('/api/settings', async (req, res) => {
    try {
      const { sourceWallet: newSource, botPrivateKeyBase58: newKey, resetHistory } = req.body;
      const oldConfig = getConfig();
      const envPath = path.resolve(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf-8');

      let sourceChanged = false;
      let botChanged = false;

      if (newSource && newSource !== oldConfig.SOURCE_WALLET) {
        envContent = envContent.replace(/^SOURCE_WALLET=.*/m, `SOURCE_WALLET=${newSource}`);
        process.env.SOURCE_WALLET = newSource;
        sourceChanged = true;
      }

      if (newKey && newKey !== oldConfig.BOT_PRIVATE_KEY_BASE58) {
        envContent = envContent.replace(/^BOT_PRIVATE_KEY_BASE58=.*/m, `BOT_PRIVATE_KEY_BASE58=${newKey}`);
        process.env.BOT_PRIVATE_KEY_BASE58 = newKey;
        botChanged = true;
      }

      fs.writeFileSync(envPath, envContent);
      const newConfig = reloadConfig();

      if (botChanged) reloadKeypair();
      if (resetHistory) resetDb();

      if (sourceChanged) {
        const heliusKey = newConfig.HELIUS_API_KEY;
        const host = req.headers.host ?? `localhost:${newConfig.PORT}`;
        const webhookUrl = `http://${host}/webhook/helius`;

        const existing = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${heliusKey}`)
          .then((r) => r.json()) as any[];
        for (const wh of existing) {
          await fetch(`https://api.helius.xyz/v0/webhooks/${wh.webhookID}?api-key=${heliusKey}`, { method: 'DELETE' });
        }

        const whRes = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${heliusKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhookURL: webhookUrl,
            transactionTypes: ['SWAP', 'TRANSFER', 'UNKNOWN'],
            accountAddresses: [newSource],
            webhookType: 'enhanced',
            txnStatus: 'success',
          }),
        });

        if (!whRes.ok) {
          const body = await whRes.text();
          throw new Error(`Webhook registration failed: ${whRes.status} – ${body}`);
        }

        stopPollingMonitor();
        startPollingMonitor(getSharedConnection());
        logger.info({ sourceWallet: newSource }, 'Source wallet changed, webhook + polling restarted');
      }

      const kp = botChanged ? reloadKeypair() : getKeypair();

      res.json({
        ok: true,
        sourceWallet: newConfig.SOURCE_WALLET,
        botWallet: kp.publicKey.toBase58(),
        sourceChanged,
        botChanged,
        historyReset: !!resetHistory,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to update settings');
      res.status(500).json({ error: (err as Error).message });
    }
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
