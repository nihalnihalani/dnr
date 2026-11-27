/** SRT captions and the shot list (Markdown and JSON) from the rendered script. */
import type { Shot } from './script';

export const TARGET_SECONDS = 170; // 2:50
export const CAP_SECONDS = 180; // 3:00

export function ts(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** On-screen text has no Markdown: code-span backticks are dropped. */
export const screenText = (line: string) => line.replace(/`/g, '');

export function parseTs(t: string): number {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(t.trim());
  if (!m) throw new Error(`bad SRT timestamp ${t}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function toSrt(shots: Shot[]): string {
  return `${shots
    .map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.caption.map(screenText).join('\n')}\n`)
    .join('\n')}`;
}

export interface SrtCue {
  index: number;
  start: number;
  end: number;
  text: string[];
}

export function parseSrt(srt: string): SrtCue[] {
  return srt
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const [idx, time, ...text] = block.split('\n');
      const [a, b] = (time ?? '').split(' --> ');
      return { index: Number(idx), start: parseTs(a ?? ''), end: parseTs(b ?? ''), text };
    });
}

export function shotListMarkdown(shots: Shot[], header: string): string {
  const esc = (t: string) => t.replace(/\|/g, '\\|');
  const L = [
    '# Video shot list',
    '',
    header,
    '',
    `Target ${mmss(TARGET_SECONDS)}, hard cap ${mmss(CAP_SECONDS)}, 1080p, captions burned in at 36 px or larger.`,
    '',
    '| Time | Shot | Caption (on screen) | Narration | Source |',
    '|---|---|---|---|---|',
  ];
  for (const s of shots)
    L.push(
      `| ${mmss(s.start)}–${mmss(s.end)} | ${esc(s.shot)} | ${s.caption.map(esc).join('<br>')} | ${esc(s.narration)} | ${esc(s.source)} |`,
    );
  return `${L.join('\n')}\n`;
}
