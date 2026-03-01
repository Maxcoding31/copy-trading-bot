import { Keypair, Connection } from '@solana/web3.js';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

let _keypair: Keypair | null = null;
let _connection: Connection | null = null;
let _extraConnections: Connection[] | null = null;

function base58Decode(str: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ALPHABET_MAP = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP.set(ALPHABET[i], i);

  const bytes: number[] = [0];
  for (const char of str) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export function reloadKeypair(): Keypair {
  _keypair = null;
  return getKeypair();
}

export function getKeypair(): Keypair {
  if (!_keypair) {
    const config = getConfig();
    try {
      const secretKey = base58Decode(config.BOT_PRIVATE_KEY_BASE58);
      _keypair = Keypair.fromSecretKey(secretKey);
      logger.info({ publicKey: _keypair.publicKey.toBase58() }, 'Bot wallet loaded');
    } catch {
      logger.fatal('Failed to decode BOT_PRIVATE_KEY_BASE58');
      process.exit(1);
    }
  }
  return _keypair;
}

/** Shared RPC connection – reused across all modules to avoid overhead */
export function getSharedConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getConfig().RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 30_000,
    });
  }
  return _connection;
}

/** Extra RPC connections parsed from EXTRA_RPC_URLS (comma-separated) */
export function getExtraConnections(): Connection[] {
  if (!_extraConnections) {
    const raw = getConfig().EXTRA_RPC_URLS;
    _extraConnections = raw
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
      .map((url) => new Connection(url, { commitment: 'confirmed' }));
    if (_extraConnections.length > 0) {
      logger.info({ count: _extraConnections.length }, 'Extra RPC connections loaded');
    }
  }
  return _extraConnections;
}

/** All connections: primary + extras (for multi-send) */
export function getAllConnections(): Connection[] {
  return [getSharedConnection(), ...getExtraConnections()];
}

/**
 * Try an RPC call on primary connection, fallback to extras on error.
 */
export async function withFallbackConnection<T>(
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  const connections = getAllConnections();
  let lastError: Error | null = null;
  for (const conn of connections) {
    try {
      return await fn(conn);
    } catch (err) {
      lastError = err as Error;
      logger.warn({ err: (err as Error).message }, 'RPC call failed, trying next endpoint');
    }
  }
  throw lastError ?? new Error('All RPC endpoints failed');
}
