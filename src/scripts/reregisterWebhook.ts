import 'dotenv/config';
import { logger } from '../utils/logger';

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const SOURCE_WALLET = process.env.SOURCE_WALLET;

if (!HELIUS_API_KEY || !SOURCE_WALLET) {
  logger.fatal('HELIUS_API_KEY and SOURCE_WALLET must be set in .env');
  process.exit(1);
}

const webhookUrl = process.argv[2];
if (!webhookUrl) {
  logger.fatal('Usage: npx tsx src/scripts/reregisterWebhook.ts <WEBHOOK_URL>');
  process.exit(1);
}

async function main() {
  // 1. List and delete all existing webhooks
  const listUrl = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;
  const existing = await fetch(listUrl).then((r) => r.json()) as any[];
  for (const wh of existing) {
    logger.info({ webhookId: wh.webhookID, url: wh.webhookURL }, 'Deleting existing webhook');
    await fetch(`https://api.helius.xyz/v0/webhooks/${wh.webhookID}?api-key=${HELIUS_API_KEY}`, { method: 'DELETE' });
  }

  // 2. Register new webhook with broad transaction types
  const body = {
    webhookURL: webhookUrl,
    transactionTypes: ['SWAP', 'TRANSFER', 'UNKNOWN'],
    accountAddresses: [SOURCE_WALLET],
    webhookType: 'enhanced',
    txnStatus: 'success',
  };

  logger.info({ webhookUrl, sourceWallet: SOURCE_WALLET, types: body.transactionTypes }, 'Registering Helius webhook...');

  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    logger.fatal({ status: res.status, body: errorBody }, 'Failed to register webhook');
    process.exit(1);
  }

  const data = await res.json();
  logger.info({ webhookId: (data as any).webhookID, data }, 'Webhook registered successfully');
  console.log('\nWebhook ID:', (data as any).webhookID);
  console.log('Full response:', JSON.stringify(data, null, 2));
}

main().catch((err) => {
  logger.fatal({ err }, 'Script failed');
  process.exit(1);
});
