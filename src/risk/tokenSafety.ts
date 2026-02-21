import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig } from '../config';
import { logger } from '../utils/logger';

export interface TokenSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check token mint account for dangerous authorities.
 * Reads the raw mint account data and extracts mintAuthority/freezeAuthority.
 *
 * SPL Token Mint layout (first 82 bytes):
 *   [0..4]   mintAuthorityOption (u32 LE): 0 = None, 1 = Some
 *   [4..36]  mintAuthority (32 bytes, only valid if option = 1)
 *   [36..44] supply (u64 LE)
 *   [44]     decimals (u8)
 *   [45]     isInitialized (bool)
 *   [46..50] freezeAuthorityOption (u32 LE): 0 = None, 1 = Some
 *   [50..82] freezeAuthority (32 bytes, only valid if option = 1)
 */
export async function checkTokenSafety(
  connection: Connection,
  mint: string,
): Promise<TokenSafetyResult> {
  const config = getConfig();

  try {
    const mintPubkey = new PublicKey(mint);
    const accountInfo = await connection.getAccountInfo(mintPubkey);

    if (!accountInfo || !accountInfo.data) {
      return { safe: false, reason: 'Mint account not found' };
    }

    const data = accountInfo.data;
    if (data.length < 82) {
      return { safe: false, reason: 'Mint account data too short' };
    }

    // Check mintAuthority
    const mintAuthorityOption = data.readUInt32LE(0);
    if (config.BLOCK_IF_MINT_AUTHORITY && mintAuthorityOption === 1) {
      const mintAuthority = new PublicKey(data.subarray(4, 36));
      logger.warn({ mint, mintAuthority: mintAuthority.toBase58() }, 'Token has active mint authority');
      return { safe: false, reason: `Mint authority active: ${mintAuthority.toBase58()}` };
    }

    // Check freezeAuthority
    const freezeAuthorityOption = data.readUInt32LE(46);
    if (config.BLOCK_IF_FREEZE_AUTHORITY && freezeAuthorityOption === 1) {
      const freezeAuthority = new PublicKey(data.subarray(50, 82));
      logger.warn({ mint, freezeAuthority: freezeAuthority.toBase58() }, 'Token has active freeze authority');
      return { safe: false, reason: `Freeze authority active: ${freezeAuthority.toBase58()}` };
    }

    return { safe: true };
  } catch (err) {
    logger.error({ err, mint }, 'Failed to check token safety');
    return { safe: false, reason: `Safety check failed: ${(err as Error).message}` };
  }
}
