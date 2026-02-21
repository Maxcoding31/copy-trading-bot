/**
 * Generate a new dedicated Solana wallet for the bot.
 * Outputs the public key and the base58-encoded private key.
 *
 * Usage:
 *   npx tsx src/scripts/generateWallet.ts
 *
 * IMPORTANT: Save the private key securely. It will only be shown ONCE.
 */
import { Keypair } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    str += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}

function main() {
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const privateKeyBase58 = base58Encode(keypair.secretKey);

  console.log('');
  console.log('='.repeat(60));
  console.log('  NEW BOT WALLET GENERATED');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Public Key  : ${publicKey}`);
  console.log('');
  console.log(`  Private Key (base58) :`);
  console.log(`  ${privateKeyBase58}`);
  console.log('');
  console.log('='.repeat(60));
  console.log('');
  console.log('  INSTRUCTIONS:');
  console.log('  1. Copy the Private Key above into your .env file');
  console.log('     as BOT_PRIVATE_KEY_BASE58');
  console.log('');
  console.log('  2. Send some SOL to the Public Key above from your');
  console.log('     Phantom wallet (start with 0.5-1 SOL for testing)');
  console.log('');
  console.log('  3. NEVER share the private key with anyone');
  console.log('');
  console.log('='.repeat(60));
  console.log('');
}

main();
