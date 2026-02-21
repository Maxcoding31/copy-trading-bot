/**
 * CLI script to register a Helius Enhanced webhook for the source wallet.
 *
 * Usage:
 *   npx tsx src/scripts/registerWebhook.ts <WEBHOOK_URL>
 *
 * Example:
 *   npx tsx src/scripts/registerWebhook.ts https://mybot.example.com/webhook/helius
 */
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
  logger.fatal('Usage: npx tsx src/scripts/registerWebhook.ts <WEBHOOK_URL>');
  process.exit(1);
}

async function main() {
  const url = `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`;

  const body = {
    webhookURL: webhookUrl,
    transactionTypes: ['SWAP'],
    accountAddresses: [SOURCE_WALLET],
    webhookType: 'enhanced',
    txnStatus: 'success',
  };

  logger.info({ webhookUrl, sourceWallet: SOURCE_WALLET }, 'Registering Helius webhook...');

  const res = await fetch(url, {
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
