/**
 * Sealing run outputs before blind labeling (audit finding T3). `label --generate` reads what the
 * packets need, then moves every run's outputs (transcripts, diffs, events, meta) and state into
 * `reports/sealed/`, writes the packet key there, records the archive's sha256 in the key, and
 * `chmod 000`s the sealed directory, the worktrees, the HOMEs and the probe answers. Packets are
 * then the only readable material. `label --freeze` unseals, after the labels are frozen.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { layout, type TrialPaths } from './env';
import { hashDir } from './home';
import { lock, unlock } from './lockdown';
import { sha256Hex } from './prng';

export const sealedDir = (P: Pick<TrialPaths, 'reportsDir'>) => join(P.reportsDir, 'sealed');
export const sealedRuns = (P: Pick<TrialPaths, 'reportsDir'>) => join(sealedDir(P), 'runs');
export const sealedState = (P: Pick<TrialPaths, 'reportsDir'>) => join(sealedDir(P), 'state');
export const sealedKeyFile = (P: Pick<TrialPaths, 'reportsDir'>) => join(sealedDir(P), 'packet-key.json');
export const sealLockFile = (P: Pick<TrialPaths, 'trialRoot'>) => join(P.trialRoot, 'seal-lock.json');

/** A run's outputs: in reports/sealed once sealed, else under $TRIAL_ROOT/out. */
export function runOutDir(P: Pick<TrialPaths, 'reportsDir' | 'trialRoot'>, runId: string): string {
  const s = join(sealedRuns(P), runId);
  return existsSync(s) ? s : layout(P.trialRoot).out(runId);
}

async function move(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await mkdir(dirname(to), { recursive: true });
  if (existsSync(to)) throw new Error(`${to} exists: outputs were already sealed`);
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/** Moves $TRIAL_ROOT/out and state into reports/sealed; returns the archive's sha256. */
export async function sealOutputs(P: TrialPaths): Promise<string> {
  await move(join(P.trialRoot, 'out'), sealedRuns(P));
  await move(join(P.trialRoot, 'state'), sealedState(P));
  return sha256Hex(`${hashDir(sealedRuns(P))}\n${hashDir(sealedState(P))}`);
}

/** Closes the sealed material while labeling runs (real runs; a dry run only moves it). */
export async function lockSeal(P: TrialPaths, log: (m: string) => void = () => {}): Promise<number> {
  if (P.dryRun) return 0;
  const t = [
    sealedDir(P),
    join(P.trialRoot, 'runs'),
    join(P.trialRoot, 'homes'),
    join(P.trialRoot, 'probe'),
  ].filter(existsSync);
  await lock(t, sealLockFile(P), log);
  return t.length;
}

export const isSealedLocked = (P: TrialPaths) => existsSync(sealLockFile(P));

export async function unseal(P: TrialPaths, log: (m: string) => void = () => {}): Promise<number> {
  return unlock(sealLockFile(P), log);
}
