/** `events.jsonl` (§7 EventRecord): appended under a lock, one JSON object per line. */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventRecord } from '@dnr/schemas';
import { ulid } from 'ulid';
import { nowMs } from './clock';
import { withLock } from './fsutil';

export function newEventId(): string {
  return ulid(nowMs());
}

export async function appendEvent(file: string, record: EventRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  await mkdir(dirname(file), { recursive: true });
  await withLock(file, () => appendFile(file, line));
}

/** Read events, skipping lines that do not parse as an EventRecord. */
export async function readEvents(
  file: string,
  filter: { order?: string; hook?: EventRecord['hook'] } = {},
): Promise<EventRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: EventRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const r = EventRecord.safeParse(json);
    if (!r.success) continue;
    if (filter.order && r.data.decision.order_id !== filter.order) continue;
    if (filter.hook && r.data.hook !== filter.hook) continue;
    out.push(r.data);
  }
  return out;
}
