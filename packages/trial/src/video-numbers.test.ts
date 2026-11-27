/**
 * videoNumbers() on constructed, labeled inputs run through score() (scripts/video/test/trial-data.ts,
 * written to a temp dir only). Field names are the ones scripts/video reads.
 */
import { describe, expect, it } from 'vitest';
import { D1, D2, D5, D6, scoreScenario } from '../../../scripts/video/test/trial-data';

describe('videoNumbers (§11, §9.6)', () => {
  it('VID-05: every row carries Y, the human re-proposal count and its confirmed flag, and the §9.6 counts', () => {
    for (const sc of [D1, D2, D5, D6]) {
      const { trial, numbers } = scoreScenario(sc);
      expect(numbers).toMatchObject({
        Y: trial.Y,
        human_reproposals: null,
        human_reproposals_confirmed: false,
        K: trial.K,
        X: trial.X,
        K_eff: trial.K_eff,
        X_eff: trial.X_eff,
        S_eff: trial.S_eff,
      });
    }
    const { numbers } = scoreScenario({ ...D2, humanReproposals: 3 });
    expect(numbers).toMatchObject({ human_reproposals: 3, human_reproposals_confirmed: true });
  });

  it('VID-05: D2 has all three card lines over K_eff, and Y counts the re-applications tests caught', () => {
    const { trial, numbers } = scoreScenario(D2);
    expect(trial.row).toBe('D2');
    expect(numbers.Y).toBe(1);
    const card = numbers.card as Record<string, { num: number; den: number }>;
    expect(Object.keys(card).sort()).toEqual(['S_eff', 'W_L', 'X_eff']);
    expect(card.X_eff).toMatchObject({ num: trial.X_eff, den: trial.K_eff });
    expect(card.S_eff).toMatchObject({ num: trial.S_eff, den: trial.K_eff });
    expect(card.W_L).toMatchObject({ num: trial.W_L, den: trial.K_eff });
    expect(numbers).toMatchObject({ W_L: trial.W_L, Q: trial.Q });
  });

  it('VID-05: D1 commit-enforce keeps the No-DNR and Steering lines and drops only W_L and Q', () => {
    const { trial, numbers } = scoreScenario(D1);
    expect([trial.row, trial.mode]).toEqual(['D1', 'commit-enforce']);
    expect(numbers.rates).toBeUndefined();
    const card = numbers.card as Record<string, { num: number; den: number }>;
    expect(Object.keys(card).sort()).toEqual(['S_eff', 'X_eff']);
    expect(card.X_eff).toMatchObject({ num: trial.X_eff, den: trial.K_eff });
    expect(card.S_eff).toMatchObject({ num: trial.S_eff, den: trial.K_eff });
    for (const k of ['W_L', 'Q', 's_close_to_l']) expect(numbers).not.toHaveProperty(k);
  });

  it('VID-05: D5 and D6 show no rate lines', () => {
    for (const sc of [D5, D6]) {
      const { numbers } = scoreScenario(sc);
      expect(numbers.rates).toBeNull();
      for (const k of ['card', 'W_L', 'Q']) expect(numbers).not.toHaveProperty(k);
    }
  });
});
