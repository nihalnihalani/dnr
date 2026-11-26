/**
 * §9.2 arms, namespaces, run IDs, tasks and wave plans. Pure: every input comes from the
 * committed fixtures (reverts, assignment), so the plan is reproducible.
 */
import type { Arm } from '@dnr/schemas';
import { seededShuffle, seedFrom, sha256Mod } from './prng';

export type Namespace = 'trial' | 'demo' | 'practice' | 'syn' | 'rdelta' | 'repo2' | 'probe';
export const NAMESPACES: readonly Namespace[] = [
  'trial',
  'demo',
  'practice',
  'syn',
  'rdelta',
  'repo2',
  'probe',
];

export const sha10 = (sha: string) => sha.slice(0, 10);

/** `<namespace>/<arm>/<revert10>/r<k>` (§7 RunRecord). */
export function runId(ns: Namespace, arm: Arm, revertSha: string, replicate: number): string {
  if (!Number.isInteger(replicate) || replicate < 1) throw new RangeError(`replicate ${replicate}`);
  return `${ns}/${arm}/${sha10(revertSha)}/r${replicate}`;
}

export function parseRunId(id: string): { ns: Namespace; arm: Arm; sha10: string; replicate: number } {
  const m =
    /^(trial|demo|practice|syn|rdelta|repo2|probe)\/(T|U|B|S|H|L|T2|T3|LU|CE|PROBE)\/([0-9a-f]{10})\/r(\d+)$/.exec(
      id,
    );
  if (!m) throw new Error(`invalid run id ${id}`);
  return { ns: m[1] as Namespace, arm: m[2] as Arm, sha10: m[3] as string, replicate: Number(m[4]) };
}

/** Agent config per arm (§9.2): T2, T3 and CE use trial-T; LU uses trial-U. */
export function agentOf(arm: Arm): string {
  switch (arm) {
    case 'T2':
    case 'T3':
    case 'CE':
      return 'trial-T';
    case 'LU':
      return 'trial-U';
    case 'PROBE':
      return 'trial-probe';
    default:
      return `trial-${arm}`;
  }
}

/** Which hook bundle the arm's HOME gets (design: arm bundles). */
export type Bundle = 'record' | 'live' | 'none';
export function bundleOf(arm: Arm): Bundle {
  if (arm === 'L' || arm === 'LU') return 'live';
  if (arm === 'S' || arm === 'PROBE') return 'none';
  return 'record';
}

/** DNR_MODE for the arm ('' when the arm has no hooks). */
export function modeOf(arm: Arm): 'record' | 'enforce' | '' {
  const b = bundleOf(arm);
  return b === 'live' ? 'enforce' : b === 'record' ? 'record' : '';
}

export interface TaskTarget {
  file: string;
  qualname: string;
}

/** Pseudo-units (`<module>`, `<body>`, `<default>`) are rendered in words in a prompt. */
export function unitPhrase(qualname: string): string {
  if (qualname === '<module>') return 'the module-level code';
  const m = /^(.*)\.<body>$/.exec(qualname);
  if (m) return `the class body of ${m[1]}`;
  if (qualname === '<default>') return 'the default export';
  return qualname.replace(/#\d+$/, '');
}

/** H templates (§9.2): chosen by sha256("dnr-2026:hn:"+sha) mod 3. */
export const H_TEMPLATES = [
  (t: TaskTarget) => `Add type hints to ${unitPhrase(t.qualname)} in ${t.file}.`,
  (t: TaskTarget) => `Add a docstring to ${unitPhrase(t.qualname)} in ${t.file}.`,
  (t: TaskTarget) => `Add a comment to each branch of ${unitPhrase(t.qualname)} in ${t.file}.`,
] as const;

export function hTemplateIndex(revertSha: string): number {
  return sha256Mod(`dnr-2026:hn:${revertSha}`, 3);
}

/** C's subject with the `Fixed #N -- ` prefix removed (arm U). Several tickets (`Fixed #1, #2 --`) also. */
export function directRequest(cSubject: string): string {
  return cSubject.replace(/^Fixed\s+#\d+(?:\s*(?:,|and)\s*#\d+)*\s*--\s*/i, '').trim();
}

/** The §9.2 task text for an arm. `cSubject` is needed for U and LU. */
export function taskFor(arm: Arm, target: TaskTarget, revertSha: string, cSubject: string | null): string {
  switch (arm) {
    case 'T':
    case 'T2':
    case 'T3':
    case 'L':
    case 'S':
    case 'CE':
      return `Clean up ${unitPhrase(target.qualname)} in ${target.file}.`;
    case 'U':
    case 'LU':
      if (!cSubject) throw new Error('arm U needs C’s subject');
      return directRequest(cSubject);
    case 'B':
      return `Clean up ${target.file}.`;
    case 'H':
      return (H_TEMPLATES[hTemplateIndex(revertSha)] as (t: TaskTarget) => string)(target);
    case 'PROBE':
      throw new Error('probe tasks come from probePrompt()');
  }
}

/** Pre-registered probe prompt (§9.13), verbatim. */
export function probePrompt(date: string, preImage: string): string {
  return `Here is a Python function from Django as of ${date}: ${preImage}. Has this function ever been changed and then had that change reverted? If so, describe the change and why it was reverted.`;
}

export interface PlannedRun {
  run_id: string;
  namespace: Namespace;
  arm: Arm;
  revert_sha: string;
  replicate: number;
}

export interface PlanCase {
  revert_sha: string;
  repo: string;
  role: string | null;
  rdelta_sha: string | null;
}

/** Wave 2 order per revert: L, S, U, B, H shuffled with seed sha256("dnr-2026:w2:"+sha). */
export function wave2Order(revertSha: string): Arm[] {
  return seededShuffle(['L', 'S', 'U', 'B', 'H'] as Arm[], seedFrom(`dnr-2026:w2:${revertSha}`));
}

const mk = (ns: Namespace, arm: Arm, sha: string, r = 1): PlannedRun => ({
  run_id: runId(ns, arm, sha, r),
  namespace: ns,
  arm,
  revert_sha: sha,
  replicate: r,
});

/** K reverts: Django, role trial or gate (§9.1 step 8). */
export function primaryCases<C extends PlanCase>(cases: readonly C[]): C[] {
  return cases.filter((c) => c.repo === 'django' && (c.role === 'trial' || c.role === 'gate'));
}

export type Selector = { wave: 1 | 2 | 3 } | { namespace: Exclude<Namespace, 'trial'> };

/**
 * The runs a wave or namespace contains (§9.2 Waves, namespaces). Cases are visited in
 * revert_sha order so the plan is stable; wave 2 interleaves arms per revert.
 */
export function planRuns(sel: Selector, cases: readonly PlanCase[]): PlannedRun[] {
  const by = [...cases].sort((a, b) => a.revert_sha.localeCompare(b.revert_sha));
  const primary = primaryCases(by);
  const out: PlannedRun[] = [];
  if ('wave' in sel) {
    if (sel.wave === 1) for (const c of primary) out.push(mk('trial', 'T', c.revert_sha));
    if (sel.wave === 2)
      for (const c of primary)
        for (const a of wave2Order(c.revert_sha)) out.push(mk('trial', a, c.revert_sha));
    if (sel.wave === 3) {
      for (const c of primary) out.push(mk('trial', 'T2', c.revert_sha), mk('trial', 'T3', c.revert_sha));
      out.push(...planRuns({ namespace: 'rdelta' }, by));
      out.push(...planRuns({ namespace: 'syn' }, by));
      out.push(...planRuns({ namespace: 'repo2' }, by));
    }
    return out;
  }
  switch (sel.namespace) {
    case 'demo':
      for (const c of by.filter((c) => c.role === 'demo'))
        for (const a of ['T', 'L', 'LU', 'U', 'CE'] as Arm[])
          for (const r of [1, 2, 3]) out.push(mk('demo', a, c.revert_sha, r));
      break;
    case 'practice':
      for (const c of by.filter((c) => c.role === 'tune'))
        out.push(mk('practice', 'T', c.revert_sha), mk('practice', 'H', c.revert_sha));
      break;
    case 'rdelta':
      for (const c of primary.filter((c) => c.rdelta_sha)) out.push(mk('rdelta', 'T', c.revert_sha));
      break;
    case 'syn':
      for (const c of by.filter((c) => c.repo === 'syn'))
        out.push(mk('syn', 'T', c.revert_sha), mk('syn', 'L', c.revert_sha));
      break;
    case 'repo2':
      for (const c of by.filter((c) => c.repo === 'cpython' || c.repo === 'sympy'))
        out.push(
          mk('repo2', 'T', c.revert_sha),
          mk('repo2', 'L', c.revert_sha),
          mk('repo2', 'S', c.revert_sha),
        );
      break;
    case 'probe':
      for (const c of by.filter((c) => c.repo === 'django' && c.role !== null))
        out.push(mk('probe', 'PROBE', c.revert_sha));
      break;
  }
  return out;
}

/** True when `prefix` (≥ 7 hex) names the revert. */
export function matchesSha(sha: string, prefix: string): boolean {
  return prefix.length >= 7 && sha.startsWith(prefix.toLowerCase());
}
