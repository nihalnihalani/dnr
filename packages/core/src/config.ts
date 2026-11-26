import { DEFAULT_CONFIG, type DnrConfig } from '@dnr/schemas';

/** The subset of `.dnr/config.json` the match engine reads. */
export type MatchConfig = Pick<
  DnrConfig,
  'threshold' | 'side_min' | 'min_order_weight' | 'prox_enabled' | 'prox_threshold' | 'fingerprint_floor'
>;

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  threshold: DEFAULT_CONFIG.threshold,
  side_min: DEFAULT_CONFIG.side_min,
  min_order_weight: DEFAULT_CONFIG.min_order_weight,
  prox_enabled: DEFAULT_CONFIG.prox_enabled,
  prox_threshold: DEFAULT_CONFIG.prox_threshold,
  fingerprint_floor: DEFAULT_CONFIG.fingerprint_floor,
};

export function matchConfig(partial: Partial<MatchConfig> = {}): MatchConfig {
  return { ...DEFAULT_MATCH_CONFIG, ...partial };
}
