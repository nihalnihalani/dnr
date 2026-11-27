/**
 * The §11 video script, by time slot, for the §9.8 row that applied. Every caption and narration
 * line is a per-row field: the outcome variants (D1 `commit-enforce`, D3/D5 `warn-only`, D5,
 * D6 via `via_d6`, `s_close_to_l`) each change only the slots §11 lists.
 */
import { fill, type VideoNumbers } from './numbers';

export interface Shot {
  id: string;
  /** Seconds from the start. */
  start: number;
  end: number;
  shot: string;
  /** On-screen caption lines (burned in). Text in backticks is a code span. */
  caption: string[];
  narration: string;
  /** Where the footage comes from (run IDs, captures), for the shot list. */
  source: string;
}

export interface ScriptContext {
  /** From reports/property-failures.md: did a property find an engine bug (§11 2:05 slot)? */
  chain: 'property' | 'fallback' | 'pending';
  /** Kiro surfaces present in `.kiro/` and `powers/` (the 2:30 card). */
  surfaces: string[];
  repo_url: string;
}

export interface Variant {
  row: VideoNumbers['row'];
  warn: boolean;
  commitEnforce: boolean;
  /** No rate lines anywhere (D6, and D5 whose numbers.json carries no rates). */
  noRates: boolean;
  /** The 0:38 slot shows the re-proposal line alone (D5, D6). */
  reproposalOnly: boolean;
  sClose: boolean;
}

export class ScriptError extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'ScriptError';
  }
}

export function variant(n: VideoNumbers): Variant {
  if (n.row === 'D4' || (n.row === 'D1' && n.mode === null))
    throw new ScriptError(
      `row ${n.row}${n.via_d6 ? ' (via D6)' : ''} switches to Touch the Plan (§9.8); the DNR video script does not apply`,
    );
  const warn = n.mode === 'warn-only';
  const commitEnforce = n.row === 'D1' && n.mode === 'commit-enforce';
  const noRates = n.via_d6 || n.row === 'D5';
  return {
    row: n.row,
    warn,
    commitEnforce,
    noRates,
    reproposalOnly: n.via_d6 || n.row === 'D5',
    sClose: !noRates && !commitEnforce && n.s_close_to_l === true,
  };
}

const RESPONSE = {
  stopped_and_reported: {
    enforce: ['The agent stops and tells you why', 'The agent stops and reports the conflict.'],
    warn: ['The agent tells you why', 'The agent reports the conflict.'],
  },
  // FB-4: the agent retried after the block and was blocked again.
  retried_and_blocked: {
    enforce: ['The agent retried and was blocked again', 'The agent retried, and DNR blocked it again.'],
    warn: ['The agent retried and was warned again', 'The agent retried, and DNR warned it again.'],
  },
  alternative_impl: {
    enforce: [
      'Blocked; the agent cleaned up without re-applying it',
      'The agent cleaned up without re-applying it.',
    ],
    warn: [
      'Warned; the agent cleaned up without re-applying it',
      'The agent cleaned up without re-applying it.',
    ],
  },
} as const;

export function buildScript(n: VideoNumbers, ctx: ScriptContext): Shot[] {
  const v = variant(n);
  const f = (t: string) => fill(n, t);
  const shots: Shot[] = [];
  const add = (s: Shot) => shots.push(s);
  const lRun = f('{{run.l_run_id}}');
  const tRun = f('{{run.t_run_id}}');
  const lu = n.run?.lu === true;

  add({
    id: 'audience',
    start: 0,
    end: 3,
    shot: 'Kiro CLI on the pinned Django checkout',
    caption: [f('{{audience}}')],
    narration: 'Your repository remembers why a change was undone.',
    source: lRun,
  });
  add({
    id: 'task',
    start: 3,
    end: 9,
    shot: 'The task prompt',
    caption: [
      f('Django reverted this: {{case.reason_short}}.'),
      f(`Agent asked: "{{run.task_short}}"${lu ? ' (direct request)' : ''}`),
    ],
    narration: lu
      ? 'This agent was asked directly for the same change.'
      : 'This agent was just asked to clean up the same code.',
    source: lRun,
  });
  add({
    id: 'edit',
    start: 9,
    end: 12,
    shot: 'The agent proposes its edit, with the diff highlighted',
    caption: ["The agent's edit"],
    narration: 'Its edit looks reasonable.',
    source: lRun,
  });

  if (v.commitEnforce) {
    add({
      id: 'block',
      start: 12,
      end: 26,
      shot: 'The commit refused by pre-commit, and the Crew `dnr` check failing',
      caption: ['Blocked at commit: this change was undone before'],
      narration: "Kiro can't stop the write, so DNR stops the commit, and the pull request.",
      source: `${f('{{run.ce_run_id}}')} and the Phase 12 Crew PR`,
    });
  } else {
    const score = n.run?.score;
    const verb = v.warn ? 'Warned' : 'Blocked';
    const blockCaption =
      score === undefined
        ? f(`${verb}: {{run.score}}`)
        : score === 1
          ? `${verb}: this exact change was undone before`
          : `${verb}: this change was tried and undone before`;
    add({
      id: 'block',
      start: 12,
      end: 19,
      shot: 'DNR refuses the write: the reason, the links, the `dnr board --open` command and the match-score badge',
      caption: [blockCaption],
      narration: v.warn
        ? 'DNR warns before the file changes, and shows why.'
        : 'DNR stops it before the file changes, and shows why.',
      source: lRun,
    });
    const o = n.run?.l_outcome;
    let resp: readonly [string, string];
    if (o === undefined) resp = [f('{{run.l_outcome}}'), f('{{run.l_outcome}}')];
    else if (o === 'shell_bypass' || o === 'landed')
      throw new ScriptError(`l_outcome ${o} is never filmed as a block (§11); use FB-1`);
    else resp = RESPONSE[o][v.warn ? 'warn' : 'enforce'];
    add({
      id: 'response',
      start: 19,
      end: 26,
      shot: "The agent's response",
      caption: [resp[0]],
      narration: resp[1],
      source: lRun,
    });
  }

  add({
    id: 'split',
    start: 26,
    end: 38,
    shot: 'Split screen without DNR: the change lands and `runtests.py` passes',
    caption: ['Without DNR: change lands · tests pass'],
    narration: 'Without DNR, it lands, and the tests pass.',
    source: tRun,
  });

  const repro = f('{{human_reproposals}} reverted changes were proposed again by people');
  add({
    id: 'problem',
    start: 38,
    end: 44,
    shot: 'Problem card',
    caption: v.reproposalOnly ? [repro] : [f('Existing tests caught {{Y}} of {{X}} re-applications'), repro],
    narration: v.reproposalOnly
      ? 'People re-propose reverted changes too.'
      : v.warn
        ? 'Tests rarely catch a revert. People re-propose them too.'
        : 'Tests rarely guard a revert. People re-propose them too.',
    source: 'reports/trial.json, reports/human-reproposals.md',
  });
  add({
    id: 'frankenstein',
    start: 44,
    end: 50,
    shot: 'Frankenstein beat',
    caption: ["Frankenstein: an old bug tracker's lessons, stitched into an agent's write path"],
    narration: "Old arguments, syntax trees, git's revert graph, and a live agent, stitched together.",
    source: 'docs/architecture.md',
  });

  const stats = 'Full stats, κ, intervals, prereg hash: /trial';
  const noLine = f('No DNR: {{X_eff}} of {{K_eff}} landed');
  const sLine = f(
    "Steering file from history (our build of New Math Data's approach): {{S_eff}} of {{K_eff}} landed",
  );
  let card: string[];
  let cardNarration: string;
  if (v.noRates) {
    card = [f('{{wording}}'), stats];
    cardNarration = n.via_d6 ? 'The trial could not produce a reliable rate.' : f('{{wording}}');
  } else if (v.commitEnforce) {
    card = [f('{{wording}}'), noLine, sLine, 'Lower is better', stats];
    cardNarration = f('Pre-registered: without DNR, {{X_eff}} of {{K_eff}}. Steering alone, {{S_eff}}.');
  } else {
    const lLine = v.warn
      ? f('DNR live, both tiers (trial configuration, not shipped): {{W_L}} of {{K_eff}} landed')
      : f('DNR live: {{W_L}} of {{K_eff}} landed');
    card = [noLine, sLine, lLine, 'Lower is better', stats];
    cardNarration = v.sClose
      ? "Steering alone came close. DNR adds the reason, the links and a maintainer's approval."
      : f(
          'Pre-registered: without DNR, {{X_eff}} of {{K_eff}}. Steering alone, {{S_eff}}. With DNR, {{W_L}}.',
        );
  }
  add({
    id: 'results',
    start: 50,
    end: 75,
    shot: `Results card for row ${n.row}${n.via_d6 ? ' (via D6)' : ''}`,
    caption: card,
    narration: cardNarration,
    source: 'reports/video/numbers.json',
  });
  add({
    id: 'tokens',
    start: 75,
    end: 98,
    shot: 'Token-diff animation: A/A′ and R/R′, the formula, the session baseline',
    caption: ['Score = matched added + removed tokens ÷ order size', f('Try it: {{playground_url}}')],
    narration:
      "DNR compares tokens per function, so formatting can't hide a re-application. Try it in your browser.",
    source: 'packages/core (the match engine), the Playground /play route',
  });
  add({
    id: 'recovery',
    start: 98,
    end: 125,
    shot: 'Recovery: terminal left, board right, run ID on screen; `dnr board --open <id>`',
    caption: [
      v.warn
        ? 'Approve → warn → allow once → re-land → expires'
        : 'Approve → block → allow once → re-land → expires',
      'local board (same UI as the Playground)',
      'clock advanced 1 h',
    ],
    narration: v.warn
      ? 'A maintainer approves every order. A wrong warning takes one click to allow, once.'
      : 'A maintainer approves every order. A wrong block takes one click to allow, once.',
    source: 'reports/video/recovery/ (Phase 13 recovery capture)',
  });
  const chain =
    ctx.chain === 'property'
      ? {
          caption: 'Spec → steering → failing property → fix → hook',
          narration: "Kiro's spec found the bug in our own matcher before any agent did.",
        }
      : ctx.chain === 'fallback'
        ? {
            caption: 'Spec → spike → steering → fix → hook',
            narration: 'A Kiro spike caught a hook behavior our spec had wrong.',
          }
        : {
            caption: '[pending: reports/property-failures.md "Engine properties" section]',
            narration: '[pending: reports/property-failures.md "Engine properties" section]',
          };
  add({
    id: 'chain',
    start: 125,
    end: 150,
    shot: `One Kiro chain (${ctx.chain}), keyed on reports/property-failures.md`,
    caption: [chain.caption],
    narration: chain.narration,
    source: 'reports/property-failures.md, docs/spikes.md, .kiro/steering/hook-contracts.md',
  });
  add({
    id: 'surfaces',
    start: 150,
    end: 164,
    shot: `Kiro surfaces card (${ctx.surfaces.join(', ') || 'none found'}), plus one frame of the Crew bot's failing check`,
    caption: [v.warn ? 'DNR flags every Crew PR' : 'DNR checks every Crew PR'],
    narration: 'The same check runs on every Kiro Crew pull request.',
    source: '.kiro/, powers/, the dnr-crew check run (Phase 12)',
  });
  add({
    id: 'end',
    start: 164,
    end: 170,
    shot: 'End card',
    caption: [
      'Some changes should stay dead.',
      f('{{playground_url}}'),
      f('`npm i -g {{package}} && dnr init`'),
      ctx.repo_url,
    ],
    narration: 'Some changes should stay dead.',
    source: 'none (title card)',
  });
  return shots;
}
