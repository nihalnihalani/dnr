import { createHash } from 'node:crypto';

/** §9.1 step 8 / §9.2 Assignment ranking key: sha256("dnr-2026:"+revert_sha), hex. */
export function seedKey(revertSha: string): string {
  return createHash('sha256').update(`dnr-2026:${revertSha}`).digest('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
