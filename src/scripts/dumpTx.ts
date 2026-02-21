import 'dotenv/config';
import { Connection } from '@solana/web3.js';

const RPC = process.env.RPC_URL!;
const WALLET = process.env.SOURCE_WALLET!;
const sig = process.argv[2];
if (!sig) { console.error('Usage: npx tsx src/scripts/dumpTx.ts <SIGNATURE>'); process.exit(1); }

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  if (!tx?.meta) { console.log('TX NOT FOUND'); return; }

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(WALLET);

  console.log('walletIdx:', idx);
  console.log('preBal:', tx.meta.preBalances[idx], 'postBal:', tx.meta.postBalances[idx], 'net:', tx.meta.postBalances[idx] - tx.meta.preBalances[idx]);

  console.log('\npreTokenBalances:');
  for (const tb of tx.meta.preTokenBalances ?? []) {
    console.log(`  idx:${tb.accountIndex} owner:${tb.owner} mint:${tb.mint} amount:${tb.uiTokenAmount.amount} dec:${tb.uiTokenAmount.decimals}`);
  }

  console.log('\npostTokenBalances:');
  for (const tb of tx.meta.postTokenBalances ?? []) {
    console.log(`  idx:${tb.accountIndex} owner:${tb.owner} mint:${tb.mint} amount:${tb.uiTokenAmount.amount} dec:${tb.uiTokenAmount.decimals}`);
  }
}

main().catch(console.error);
