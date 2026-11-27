/**
 * The §15 pitch, the Devpost tagline, the README one-liner and the write-up Impact paragraph,
 * generated from reports/video/numbers.json for the §9.8 row that applied (plan 02 §15, 09 §11).
 * With no numbers.json, every row-dependent sentence is a pending marker, never a guess.
 */
import { fill, pending, type VideoNumbers } from '../video/numbers';
import { variant } from '../video/script';

export const HEADLINE = '"Your repository remembers why. Your agent doesn\'t."';
const NO_NUMBERS = pending('reports/video/numbers.json (`dnr trial report`, Phase 11)');
const LEAD = "When a Kiro agent's write would bring a reverted change back,";

export function pitchMechanism(n: VideoNumbers | null): string {
  if (!n) return NO_NUMBERS;
  const v = variant(n);
  if (v.commitEnforce) return `${LEAD} the commit and the Crew check stop it.`;
  if (v.warn) return `${LEAD} a Pre Tool Use hook warns the agent before the file changes.`;
  return `${LEAD} a Pre Tool Use hook stops it before the file changes.`;
}

export function pitchResult(n: VideoNumbers | null): string {
  if (!n) return NO_NUMBERS;
  const v = variant(n);
  if (n.via_d6 || n.row === 'D5' || v.commitEnforce) return fill(n, '{{wording}}');
  const base =
    n.row === 'D3'
      ? fill(
          n,
          'In {{Q}} trial runs (trial configuration, not shipped), DNR caught a re-application before the file changed.',
        )
      : fill(
          n,
          'In {{Q}} live-arm runs, DNR blocked a re-application before the file changed; {{W_L}} of {{K_eff}} still landed.',
        );
  return v.sClose
    ? `${base} ${fill(n, "A steering file from history came close ({{S_eff}} of {{K_eff}}); DNR adds the reason, the links and a maintainer's approval.")}`
    : base;
}

export function pitch(n: VideoNumbers | null): string {
  return [
    `> **${HEADLINE}**`,
    '>',
    "> DNR turns a repo's reverts into do-not-resurrect orders. Each order is generated from git and the original ticket, approved by a maintainer, and kept in a graveyard you can browse.",
    '>',
    `> ${pitchMechanism(n)} It shows the reason and links to the original commit, the revert, and the ticket. Re-landing a fixed version takes one approval. ${pitchResult(n)} The known gaps are listed in the threat model.`,
    '>',
    '> The trial was pre-registered and labeled blind, and every run is public. Judges can try it in a browser.',
  ].join('\n');
}

/** Row-independent: the §15 headline carries no rate and no enforcement verb. */
export const tagline = () => HEADLINE.replace(/^"|"$/g, '');

export const readmeOneLiner = (n: VideoNumbers | null) =>
  n ? `DNR turns a repo's reverts into do-not-resurrect orders. ${pitchMechanism(n)}` : NO_NUMBERS;

/** §11 Impact: X_eff/K_eff, S_eff/K_eff, W_L/K_eff, Q, Y/X, human re-proposals, the maintainer pilot. */
export function impact(n: VideoNumbers | null, pilot: string | null): string {
  const pilotLine = pilot ?? pending('reports/pilot.json (maintainer pilot, §9.15, Phase 13)');
  if (!n) return `${NO_NUMBERS} Maintainer pilot: ${pilotLine}`;
  const v = variant(n);
  const repro = fill(
    n,
    'People proposed {{human_reproposals}} reverted changes again (Django and CPython history, §9.9).',
  );
  if (n.via_d6 || n.row === 'D5') return `${fill(n, '{{wording}}')} ${repro} Maintainer pilot: ${pilotLine}`;
  const tests = fill(n, 'Existing tests caught {{Y}} of {{X}} re-applications.');
  if (v.commitEnforce)
    return `${fill(n, '{{wording}}')} ${fill(n, 'In the pre-registered trial, without DNR {{X_eff}} of {{K_eff}} cleanup runs landed a reverted change; with a steering file from history, {{S_eff}} of {{K_eff}}.')} ${tests} ${repro} Maintainer pilot: ${pilotLine}`;
  const lArm = v.warn ? 'with DNR live (both tiers, trial configuration, not shipped)' : 'with DNR live';
  return `${fill(n, `In the pre-registered trial, without DNR {{X_eff}} of {{K_eff}} cleanup runs landed a reverted change; with a steering file from history, {{S_eff}} of {{K_eff}}; ${lArm}, {{W_L}} of {{K_eff}}.`)} ${pitchResult(n)} ${tests} ${repro} Maintainer pilot: ${pilotLine}`;
}
