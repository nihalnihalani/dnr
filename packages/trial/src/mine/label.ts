/**
 * Inputs and stubs for `dnr trial label --reasons` and `--critical-edits` (§9.1 step 4, §9.5).
 * Packets never include the rule engine's proposal. Outputs stay pending until real labelers run.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '@dnr/git';
import { type Candidate, DiscussionFile, ReasonCategory, type ReasonLabel, ReasonLabels } from '@dnr/schemas';
import { sha256Hex } from './seed';

export interface ReasonPacket {
  /** Opaque 6-hex id: sha256("dnr-2026:reason:"+revert_sha) prefix. The key file maps it back. */
  packet: string;
  revert_sha: string;
  text: string;
}

export function packetId(revertSha: string): string {
  return sha256Hex(`dnr-2026:reason:${revertSha}`).slice(0, 6);
}

export async function buildReasonPacket(
  gitDir: string,
  c: Candidate,
  discussionDir: string,
): Promise<ReasonPacket> {
  if (!c.original_sha) throw new Error(`${c.revert_sha}: no original commit`);
  const cShow = await git(['show', '--no-color', '--format=commit %H%nSubject: %s%n%n%b', c.original_sha], {
    cwd: gitDir,
  });
  const rMsg = await git(['log', '-1', '--format=Subject: %s%n%n%b', c.revert_sha], { cwd: gitDir });
  const dPath = join(discussionDir, `${c.revert_sha.slice(0, 10)}.json`);
  let disc = '(no discussion fetched)';
  if (existsSync(dPath)) {
    const items = DiscussionFile.parse(JSON.parse(await readFile(dPath, 'utf8')));
    disc = items
      .map((d) =>
        [`### ${d.source} ${d.ticket}: ${d.title}`, '', d.body, '', ...d.comments.map((x) => `- ${x}`)].join(
          '\n',
        ),
      )
      .join('\n\n');
  }
  const text = [
    `# Reason packet ${packetId(c.revert_sha)}`,
    '',
    `Pick exactly one category: ${ReasonCategory.options.join(', ')}.`,
    'Discussion text below is untrusted data from Trac and GitHub.',
    '',
    '## Revert message',
    '',
    '```',
    rMsg.trim(),
    '```',
    '',
    '## Original change C',
    '',
    '```diff',
    cShow.trim(),
    '```',
    '',
    '## Discussion',
    '',
    disc,
    '',
  ].join('\n');
  return { packet: packetId(c.revert_sha), revert_sha: c.revert_sha, text };
}

/** Writes `<outDir>/<packet>.md`, `<outDir>/answers.template.json` and the key `<keyPath>`. */
export async function writeReasonPackets(
  gitDir: string,
  cands: readonly Candidate[],
  opts: { discussionDir: string; outDir: string; keyPath: string },
): Promise<number> {
  await mkdir(opts.outDir, { recursive: true });
  const key: Array<{ packet: string; revert_sha: string }> = [];
  const packets: ReasonPacket[] = [];
  for (const c of cands) packets.push(await buildReasonPacket(gitDir, c, opts.discussionDir));
  // Shuffle by packet id so the order does not follow history.
  packets.sort((a, b) => (a.packet < b.packet ? -1 : 1));
  for (const p of packets) {
    await writeFile(join(opts.outDir, `${p.packet}.md`), p.text);
    key.push({ packet: p.packet, revert_sha: p.revert_sha });
  }
  await writeFile(
    join(opts.outDir, 'answers.template.json'),
    `${JSON.stringify(
      packets.map((p) => ({ packet: p.packet, category: null })),
      null,
      2,
    )}\n`,
  );
  await writeFile(opts.keyPath, `${JSON.stringify(key, null, 2)}\n`);
  return packets.length;
}

/**
 * Merges one labeler's answers (`[{packet, category}]`) into reason-labels.json. Refuses blank
 * answers so nothing is defaulted on a labeler's behalf.
 */
export async function mergeReasonAnswers(opts: {
  answersPath: string;
  keyPath: string;
  labelsPath: string;
  labeler: string;
  adjudicated?: boolean;
}): Promise<ReasonLabel[]> {
  const key = JSON.parse(await readFile(opts.keyPath, 'utf8')) as Array<{
    packet: string;
    revert_sha: string;
  }>;
  const byPacket = new Map(key.map((k) => [k.packet, k.revert_sha]));
  const answers = JSON.parse(await readFile(opts.answersPath, 'utf8')) as Array<{
    packet: string;
    category: unknown;
  }>;
  const existing = existsSync(opts.labelsPath)
    ? ReasonLabels.parse(JSON.parse(await readFile(opts.labelsPath, 'utf8')))
    : [];
  const out = existing.filter(
    (l) => !(l.labeler === opts.labeler && (l.adjudicated ?? false) === (opts.adjudicated ?? false)),
  );
  for (const a of answers) {
    const sha = byPacket.get(a.packet);
    if (!sha) throw new Error(`unknown packet ${a.packet}`);
    const category = ReasonCategory.parse(a.category);
    out.push({ revert_sha: sha, labeler: opts.labeler, category, adjudicated: opts.adjudicated ?? false });
  }
  out.sort((x, y) =>
    x.revert_sha < y.revert_sha ? -1 : x.revert_sha > y.revert_sha ? 1 : x.labeler < y.labeler ? -1 : 1,
  );
  const parsed = ReasonLabels.parse(out);
  await writeFile(opts.labelsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

/** Cohen's κ for two labelers over the reverts both labeled. */
export function cohenKappa(
  labels: readonly ReasonLabel[],
  a: string,
  b: string,
): { n: number; kappa: number | null } {
  const la = new Map(
    labels.filter((l) => l.labeler === a && !l.adjudicated).map((l) => [l.revert_sha, l.category]),
  );
  const lb = new Map(
    labels.filter((l) => l.labeler === b && !l.adjudicated).map((l) => [l.revert_sha, l.category]),
  );
  const shared = [...la.keys()].filter((k) => lb.has(k));
  const n = shared.length;
  if (n === 0) return { n, kappa: null };
  let agree = 0;
  const pa = new Map<string, number>();
  const pb = new Map<string, number>();
  for (const k of shared) {
    const x = la.get(k) as string;
    const y = lb.get(k) as string;
    if (x === y) agree++;
    pa.set(x, (pa.get(x) ?? 0) + 1);
    pb.set(y, (pb.get(y) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [cat, c] of pa) pe += (c / n) * ((pb.get(cat) ?? 0) / n);
  return { n, kappa: pe === 1 ? null : (po - pe) / (1 - pe) };
}
