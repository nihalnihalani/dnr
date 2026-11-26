/**
 * `dnr trial report` (§8): `reports/trial.md`, `reports/video/numbers.json` and
 * `reports/decision.md` (§9.8 rows in order, pre-registered wordings verbatim), all generated
 * from a scored analysis. Nothing here is written unless real scored data exists.
 */
import type { TrialResult } from '@dnr/schemas';
import { DECISION_TABLE, outcomeText, WORDINGS } from './decision';
import type { Analysis } from './score';
import { formatRatio, type RatioOut } from './stats';

const fmtP = (p: number) => (p < 0.001 ? '< 0.001' : p.toFixed(3));
const fmtK = (k: number | null) => (k === null ? 'n/a' : k.toFixed(2));
const fmtCI = (ci: [number, number] | null) => (ci ? `${ci[0].toFixed(2)}–${ci[1].toFixed(2)}` : 'n/a');

export function trialMarkdown(a: Analysis): string {
  const r = a.result;
  const L: string[] = [
    '# Trial results',
    '',
    `Pre-registration: \`prereg-v1\` at ${r.prereg_sha}. Content hash: \`${r.content_hash}\`.`,
    '',
  ];
  L.push(`**Decision row:** ${r.row}${r.via_d6 ? ' (via D6)' : ''} — ${outcomeText(a.decision)}.`, '');
  L.push('## Measures (§9.6)', '', '| Measure | Value |', '|---|---|');
  for (const [k, v] of Object.entries(a.ratios)) L.push(`| ${k} | ${formatRatio(v)} |`);
  L.push(
    `| Q (L runs with a blocked FULL/CORE proposal) | ${r.Q} |`,
    `| False blocks in L (blocked proposals labeled NONE) | ${r.Q_false_blocks} |`,
  );
  L.push(
    `| RL (re-lands) | ${r.RL} |`,
    `| Warn blocks (never false blocks) | ${r.warn_blocks} |`,
    `| Held-out recall | ${r.held_out_recall ?? 'n/a'} |`,
    '',
  );
  L.push('### Z/X by order size', '', '| Order size | Z/X |', '|---|---|');
  for (const [k, v] of Object.entries(a.z_by_order_size)) L.push(`| ${k} | ${formatRatio(v)} |`);
  L.push(
    '',
    `Misses (X − Z): ${a.misses.length ? a.misses.map((s) => `\`${s.slice(0, 10)}\``).join(', ') : 'none'}.`,
    '',
  );
  L.push('## Paired comparisons (underpowered)', '', '| Pair | b | c | p |', '|---|---|---|---|');
  for (const m of Object.values(a.mcnemar)) L.push(`| ${m.label} | ${m.b} | ${m.c} | ${fmtP(m.p)} |`);
  L.push(
    '',
    '## Labeler agreement (§9.5)',
    '',
    '| Scheme | n | raw | κ (95% CI) | PABAK (95% CI) | AC1 (95% CI) |',
    '|---|---|---|---|---|---|',
  );
  for (const [k, g] of Object.entries(a.agreement))
    L.push(
      `| ${k} | ${g.n} | ${fmtK(g.raw)} | ${fmtK(g.kappa)} (${fmtCI(g.ci.kappa)}) | ${fmtK(g.pabak)} (${fmtCI(g.ci.pabak)}) | ${fmtK(g.ac1)} (${fmtCI(g.ci.ac1)}) |`,
    );
  L.push('', '## Exclusions (pre-registered: listed, never dropped silently)', '');
  if (a.dropped.length + a.excluded.length === 0) L.push('None.');
  for (const d of a.dropped)
    L.push(`- \`${d.run_id}\`: ${d.status}${d.notes.length ? ` (${d.notes.join('; ')})` : ''}`);
  for (const d of a.excluded) L.push(`- \`${d.run_id}\`: excluded, ${d.notes.join('; ')}`);
  L.push('', '## L runs with `error_open` (§5.16)', '');
  L.push(a.error_open_runs.length ? a.error_open_runs.map((x) => `- \`${x}\``).join('\n') : 'None.');
  L.push(
    '',
    `Without them: W_L/K_eff = ${formatRatio(a.without_error_open.W_L)}, Q = ${a.without_error_open.Q}.`,
    '',
  );
  L.push('## Secondary cohorts (never change the decision)', '');
  for (const [cohort, rec] of Object.entries(r.secondary)) {
    if (rec === null) L.push(`- ${cohort}: not available`);
    else if (typeof rec === 'number') L.push(`- ${cohort}: ${rec}`);
    else
      for (const [k, v] of Object.entries(rec as Record<string, RatioOut>))
        L.push(`- ${cohort} ${k}: ${formatRatio(v)}`);
  }
  if (a.exploratory.length)
    L.push('', '## Exploratory (not pre-registered)', '', ...a.exploratory.map((x) => `- ${x}`));
  return `${L.join('\n')}\n`;
}

/** Numbers for captions and the write-up, from the applied row only (VID-05 checks them against trial.json). */
export function videoNumbers(a: Analysis): Record<string, unknown> {
  const r = a.result;
  const base = {
    row: r.row,
    via_d6: r.via_d6,
    mode: r.mode,
    prereg_sha: r.prereg_sha,
    content_hash: r.content_hash,
  };
  if (r.via_d6) return { ...base, wording: WORDINGS.D6_inconclusive, rates: null };
  if (r.row === 'D5') return { ...base, wording: WORDINGS.D5_null(r.K, r.X), rates: null };
  if (r.row === 'D1' && r.mode === 'commit-enforce')
    return { ...base, wording: WORDINGS.D1_study_failed, rates: null };
  return {
    ...base,
    K: r.K,
    X: r.X,
    K_eff: r.K_eff,
    X_eff: r.X_eff,
    S_eff: r.S_eff,
    W_L: r.W_L,
    Q: r.Q,
    x_over_k: a.ratios['X/K'],
    card: { X_eff: a.ratios['X_eff/K_eff'], S_eff: a.ratios['S_eff/K_eff'], W_L: a.ratios['W_L/K_eff'] },
    s_close_to_l: Math.abs(r.S_eff - r.W_L) <= 1,
  };
}

export function decisionMarkdown(a: Analysis, r: TrialResult = a.result): string {
  const L = [
    '# Decision (§9.8)',
    '',
    'Rows are evaluated in the order D1, D6, D2, D3, D4, D5; the first row that matches decides.',
    '',
    DECISION_TABLE,
    '',
    '## Evaluation',
    '',
    ...a.decision.trace.map((t) => `- ${t}`),
    '',
    `**Row:** ${r.row}. **via_d6:** ${r.via_d6}. **Outcome:** ${outcomeText(a.decision)}. **Mode:** ${r.mode ?? 'null (Touch the Plan)'}.`,
    '',
  ];
  if (r.via_d6) L.push(`Wording: "${WORDINGS.D6_inconclusive}"`);
  else if (r.row === 'D5') L.push(`Wording: "${WORDINGS.D5_null(r.K, r.X)}"`);
  else if (r.row === 'D1' && r.mode === 'commit-enforce') L.push(`Wording: "${WORDINGS.D1_study_failed}"`);
  return `${L.join('\n')}\n`;
}
