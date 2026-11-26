/**
 * The human-attested order record (wave-3 N3): `<state>/attested.json`, rewritten after every
 * order mutation made through the store, i.e. by human-guarded `dnr orders …` commands, the board
 * and `dnr tamper accept`. For an order it lists, its status is the human's decision.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Order } from '@dnr/schemas';

export interface AttestedRecord {
  version: 1;
  updated_at: string;
  by: string;
  orders: Record<string, { status: Order['status']; sha256: string }>;
}

/** Canonical content hash of an order (sorted keys). */
export function orderHash(o: Order): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) out[k] = norm((x as Record<string, unknown>)[k]);
      return out;
    }
    return x;
  };
  return createHash('sha256')
    .update(JSON.stringify(norm(o)))
    .digest('hex');
}

export function readAttested(file: string): AttestedRecord | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as AttestedRecord;
    return j && j.version === 1 && j.orders && typeof j.orders === 'object' ? j : null;
  } catch {
    return null;
  }
}

export function writeAttested(file: string, orders: readonly Order[], by: string, at: string): void {
  const rec: AttestedRecord = { version: 1, updated_at: at, by, orders: {} };
  for (const o of [...orders].sort((a, b) => a.id.localeCompare(b.id)))
    rec.orders[o.id] = { status: o.status, sha256: orderHash(o) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameSync(tmp, file);
}
