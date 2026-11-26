/**
 * `.dnr/config.json` (plan §7 "Config lookup"). Every key is optional in the file;
 * `DnrConfig.parse({})` yields the defaults.
 */
import { z } from 'zod';

export const DEFAULT_CONFIG = {
  mode: 'enforce',
  threshold: 0.6,
  side_min: 0.3,
  min_order_weight: 8,
  prox_enabled: false,
  prox_threshold: 0.5,
  decision_format: 'deny',
  session_ttl_minutes: 30,
  stop_max_forced_turns: 2,
  board_port: 4317,
  fingerprint_floor: 0.7,
} as const;

export const DnrConfig = z.strictObject({
  mode: z.enum(['enforce', 'record', 'warn-only', 'commit-enforce']).default(DEFAULT_CONFIG.mode),
  threshold: z.number().min(0).max(1).default(DEFAULT_CONFIG.threshold),
  side_min: z.number().min(0).max(1).default(DEFAULT_CONFIG.side_min),
  min_order_weight: z.number().nonnegative().default(DEFAULT_CONFIG.min_order_weight),
  prox_enabled: z.boolean().default(DEFAULT_CONFIG.prox_enabled),
  prox_threshold: z.number().min(0).max(1).default(DEFAULT_CONFIG.prox_threshold),
  decision_format: z.enum(['deny', 'ask']).default(DEFAULT_CONFIG.decision_format),
  session_ttl_minutes: z.number().int().positive().default(DEFAULT_CONFIG.session_ttl_minutes),
  stop_max_forced_turns: z.number().int().min(0).default(DEFAULT_CONFIG.stop_max_forced_turns),
  board_port: z.number().int().min(1).max(65535).default(DEFAULT_CONFIG.board_port),
  fingerprint_floor: z.number().min(0).max(1).default(DEFAULT_CONFIG.fingerprint_floor),
});
export type DnrConfig = z.infer<typeof DnrConfig>;
