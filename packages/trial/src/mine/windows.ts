import type { MatchMethod } from '@dnr/git';

export type MiningWindow = 'W0' | 'W1' | 'W2' | 'W3' | 'W4';

/** §9.1 step 8 windows. Years use the revert's committer date in UTC. */
export const WINDOWS: ReadonlyArray<{ id: MiningWindow; label: string; from?: number; to?: number }> = [
  { id: 'W0', label: '2023–2025', from: 2023, to: 2025 },
  { id: 'W1', label: '2020–2022', from: 2020, to: 2022 },
  { id: 'W2', label: '2017–2019', from: 2017, to: 2019 },
  { id: 'W3', label: '2015–2016', from: 2015, to: 2016 },
  { id: 'W4', label: 'silent reverts (patch-id), 2015–2025', from: 2015, to: 2025 },
];

export const MIN_YEAR = 2015;
export const MAX_YEAR = 2025;

export function windowOf(committedAt: string, method: MatchMethod | null): MiningWindow | null {
  const y = new Date(committedAt).getUTCFullYear();
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  if (method === 'patch-id-silent') return 'W4';
  for (const w of WINDOWS) {
    if (w.id !== 'W4' && w.from !== undefined && w.to !== undefined && y >= w.from && y <= w.to) return w.id;
  }
  return null;
}
