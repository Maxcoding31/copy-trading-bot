import express from 'express';
import fs from 'fs';
import path from 'path';
import { PublicKey } from '@solana/web3.js';
import { loadConfig, getConfig, reloadConfig } from './config';
import { initDb, closeDb, resetDb } from './db/sqlite';
import { getKeypair, reloadKeypair, getSharedConnection } from './trade/solana';
import { webhookRouter } from './webhook/handler';
import { startPollingMonitor, stopPollingMonitor, clearProcessing } from './monitor/wsMonitor';
import { notifyStartup, notifyError } from './notify/telegram';
import {
  getVirtualPnL, getVirtualPortfolio, getDailySpent, getOpenPositionCount,
  getRecentSourceTrades, getRecentVirtualTrades,
  recordPnlSnapshot, getPnlHistory, getDailySummary,
  markEventProcessed,
  initVirtualWallet, getVirtualCash, setVirtualCash,
} from './db/repo';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  initDb();
  initVirtualWallet(config.VIRTUAL_STARTING_BALANCE);
  const keypair = getKeypair();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use(express.static(path.resolve(__dirname, '..', 'public')));

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

  app.get('/health', (_req, res) => {
    const cfg = getConfig();
    const kp = getKeypair();
    const pnl = getVirtualPnL();
    const portfolio = getVirtualPortfolio();
    const openPositions = getOpenPositionCount();
    const dailySpent = getDailySpent();
    const virtualCash = getVirtualCash();

    res.json({
      status: 'ok',
      mode: cfg.DRY_RUN ? 'SIMULATION' : 'LIVE',
      paused: cfg.PAUSE_TRADING,
      uptime: Math.round(process.uptime()),
      botWallet: kp.publicKey.toBase58(),
      sourceWallet: cfg.SOURCE_WALLET,
      settings: {
        copyRatio: cfg.COPY_RATIO,
        maxSolPerTrade: cfg.MAX_SOL_PER_TRADE,
        maxSolPerDay: cfg.MAX_SOL_PER_DAY,
        maxOpenPositions: cfg.MAX_OPEN_POSITIONS,
        slippageBps: cfg.SLIPPAGE_BPS,
      },
      budget: {
        dailySpent: +dailySpent.toFixed(6),
        dailyLimit: cfg.MAX_SOL_PER_DAY,
        remaining: +(cfg.MAX_SOL_PER_DAY - dailySpent).toFixed(6),
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
        virtualCash: +virtualCash.toFixed(6),
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/dashboard', (_req, res) => {
    const cfg = getConfig();
    const kp = getKeypair();
    const pnl = getVirtualPnL();
    const portfolio = getVirtualPortfolio();
    const openPositions = getOpenPositionCount();
    const dailySpent = getDailySpent();
    const startingBalance = cfg.VIRTUAL_STARTING_BALANCE;
    const currentBalance = startingBalance + pnl.pnl;
    const pnlPercent = startingBalance > 0 ? (pnl.pnl / startingBalance) * 100 : 0;
    const virtualCash = getVirtualCash();

    res.json({
      wallet: {
        startingBalance,
        currentBalance: +currentBalance.toFixed(6),
        virtualCash: +virtualCash.toFixed(6),
        pnl: +pnl.pnl.toFixed(6),
        pnlPercent: +pnlPercent.toFixed(2),
        totalInvested: +pnl.totalSpent.toFixed(6),
        totalReceived: +pnl.totalReceived.toFixed(6),
      },
      config: {
        mode: cfg.DRY_RUN ? 'SIMULATION' : 'LIVE',
        paused: cfg.PAUSE_TRADING,
        copyRatio: cfg.COPY_RATIO,
        maxSolPerTrade: cfg.MAX_SOL_PER_TRADE,
        maxSolPerDay: cfg.MAX_SOL_PER_DAY,
        maxOpenPositions: cfg.MAX_OPEN_POSITIONS,
        slippageBps: cfg.SLIPPAGE_BPS,
        sourceWallet: cfg.SOURCE_WALLET,
        botWallet: kp.publicKey.toBase58(),
      },
      budget: {
        dailySpent: +dailySpent.toFixed(6),
        dailyLimit: cfg.MAX_SOL_PER_DAY,
        remaining: +(cfg.MAX_SOL_PER_DAY - dailySpent).toFixed(6),
      },
      positions: {
        openCount: openPositions,
        maxPositions: cfg.MAX_OPEN_POSITIONS,
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
      pnlHistory: getPnlHistory(24),
      dailySummary: getDailySummary(),
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Settings API ─────────────────────────────────
  app.post('/api/settings', async (req, res) => {
    try {
      const {
        sourceWallet: newSource,
        botPrivateKeyBase58: newKey,
        resetHistory,
        virtualBalance: newBalance,
        copyRatio: newRatio,
      } = req.body;

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

      const balanceChanged = newBalance != null && Number(newBalance) > 0 && Number(newBalance) !== oldConfig.VIRTUAL_STARTING_BALANCE;
      if (balanceChanged) {
        envContent = envContent.replace(/^VIRTUAL_STARTING_BALANCE=.*/m, `VIRTUAL_STARTING_BALANCE=${newBalance}`);
        process.env.VIRTUAL_STARTING_BALANCE = String(newBalance);
      }

      if (newRatio != null && Number(newRatio) > 0 && Number(newRatio) <= 1 && Number(newRatio) !== oldConfig.COPY_RATIO) {
        envContent = envContent.replace(/^COPY_RATIO=.*/m, `COPY_RATIO=${newRatio}`);
        process.env.COPY_RATIO = String(newRatio);
      }

      fs.writeFileSync(envPath, envContent);
      const newConfig = reloadConfig();

      if (botChanged) reloadKeypair();

      if (resetHistory) {
        stopPollingMonitor();
        clearProcessing();
        resetDb();
        initVirtualWallet(newConfig.VIRTUAL_STARTING_BALANCE);

        const conn = getSharedConnection();
        const wallet = newConfig.SOURCE_WALLET;
        try {
          const recentSigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 20 });
          for (const s of recentSigs) {
            markEventProcessed(s.signature);
          }
          logger.info({ count: recentSigs.length }, 'Pre-populated processed_events after reset');
        } catch (e) {
          logger.warn({ err: e }, 'Failed to pre-populate processed_events');
        }

        startPollingMonitor(conn);
        logger.info('History reset complete, polling monitor restarted');
      } else if (balanceChanged) {
        const delta = Number(newBalance) - oldConfig.VIRTUAL_STARTING_BALANCE;
        const currentCash = getVirtualCash();
        setVirtualCash(currentCash + delta);
        logger.info({ oldBalance: oldConfig.VIRTUAL_STARTING_BALANCE, newBalance, newCash: currentCash + delta }, 'Virtual cash adjusted for new starting balance');
      }

      if (sourceChanged && !resetHistory) {
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
            accountAddresses: [newConfig.SOURCE_WALLET],
            webhookType: 'enhanced',
            txnStatus: 'success',
          }),
        });

        if (!whRes.ok) {
          const body = await whRes.text();
          throw new Error(`Webhook registration failed: ${whRes.status} – ${body}`);
        }

        stopPollingMonitor();
        clearProcessing();
        startPollingMonitor(getSharedConnection());
        logger.info({ sourceWallet: newConfig.SOURCE_WALLET }, 'Source wallet changed, webhook + polling restarted');
      }

      const kp = botChanged ? reloadKeypair() : getKeypair();

      res.json({
        ok: true,
        sourceWallet: newConfig.SOURCE_WALLET,
        botWallet: kp.publicKey.toBase58(),
        sourceChanged,
        botChanged,
        historyReset: !!resetHistory,
        virtualBalance: newConfig.VIRTUAL_STARTING_BALANCE,
        copyRatio: newConfig.COPY_RATIO,
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

    try {
      const connection = getSharedConnection();
      startPollingMonitor(connection);
    } catch (err) {
      logger.error({ err }, 'Failed to start polling monitor, relying on webhook only');
    }
  });

  setInterval(() => {
    try {
      const pnl = getVirtualPnL();
      const cash = getVirtualCash();
      recordPnlSnapshot(cash, pnl.pnl);
    } catch { /* non-critical */ }
  }, 60_000);

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
