import 'dotenv/config';
import { z } from 'zod';
import { logger } from './utils/logger';

const boolStr = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const configSchema = z.object({
  // Helius
  HELIUS_API_KEY: z.string().min(1, 'HELIUS_API_KEY is required'),
  RPC_URL: z.string().url('RPC_URL must be a valid URL'),

  // Jupiter
  JUPITER_API_KEY: z.string().min(1, 'JUPITER_API_KEY is required'),

  // Bot wallet
  BOT_PRIVATE_KEY_BASE58: z.string().min(32, 'BOT_PRIVATE_KEY_BASE58 is required'),

  // Source wallet
  SOURCE_WALLET: z.string().min(32),

  // Risk
  COPY_RATIO: z.coerce.number().gt(0).lte(1),
  MAX_SOL_PER_TRADE: z.coerce.number().gt(0),
  MAX_SOL_PER_DAY: z.coerce.number().gt(0),
  MIN_SOL_PER_TRADE: z.coerce.number().gt(0),

  // Position limits
  MAX_OPEN_POSITIONS: z.coerce.number().int().gte(1).default(10),

  // Slippage
  SLIPPAGE_BPS: z.coerce.number().int().gte(1).lte(5000),
  MAX_PRICE_IMPACT_BPS: z.coerce.number().int().gte(1).lte(10000),

  // Priority fee for fast transaction landing (in lamports)
  PRIORITY_FEE_LAMPORTS: z.coerce.number().int().gte(0).default(100000),

  // Cooldown
  COOLDOWN_SECONDS_PER_TOKEN: z.coerce.number().int().gte(0),

  // Token safety
  BLOCK_IF_MINT_AUTHORITY: boolStr,
  BLOCK_IF_FREEZE_AUTHORITY: boolStr,

  // Virtual simulation
  VIRTUAL_STARTING_BALANCE: z.coerce.number().gt(0).default(5),
  DRY_RUN_ACCURATE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // Fee guards
  MAX_FEE_PCT: z.coerce.number().gte(0).lte(100).default(5),
  MIN_SOL_RESERVE: z.coerce.number().gte(0).default(0.005),

  // Slippage alert threshold (LIVE mode compareExecution)
  COMPARE_ALERT_PCT: z.coerce.number().gte(0).default(3),

  // Kill switches
  PAUSE_TRADING: boolStr,
  DRY_RUN: boolStr,

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  // Server
  PORT: z.coerce.number().int().default(3000),
});

export type Config = z.infer<typeof configSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    logger.fatal({ errors: result.error.flatten().fieldErrors }, 'Invalid configuration');
    process.exit(1);
  }
  _config = result.data;
  logger.info('Configuration loaded and validated');
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded – call loadConfig() first');
  return _config;
}

export function reloadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${JSON.stringify(result.error.flatten().fieldErrors)}`);
  }
  _config = result.data;
  logger.info('Configuration reloaded');
  return _config;
}

/** SOL mint address (native) */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Wrapped SOL */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** SOL decimals */
export const SOL_DECIMALS = 9;

/** Convert lamports to SOL */
export const lamportsToSol = (lamports: bigint | number): number =>
  Number(lamports) / 1e9;

/** Convert SOL to lamports */
export const solToLamports = (sol: number): bigint =>
  BigInt(Math.round(sol * 1e9));
