/** The DNR clock: `DNR_NOW` (ISO date or epoch milliseconds) overrides the system time (§8). */
export function nowMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.DNR_NOW?.trim();
  if (v) {
    if (/^\d+$/.test(v)) return Number(v);
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

export function nowIso(env: NodeJS.ProcessEnv = process.env): string {
  return new Date(nowMs(env)).toISOString();
}

/** Parse a TTL such as `1h`, `30m`, `90s`, `2d` or a bare number of seconds. */
export function parseTtl(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid ttl: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return Math.round(n * mult);
}
