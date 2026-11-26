/**
 * Grant provenance (wave-2 C3/H4, lead decision). A same-OS-user agent cannot be fully stopped
 * from forging a human approval: the R6 guard is a speed bump, not a boundary. So every grant
 * records how it was made and any agent marker seen at that moment, and a grant made while an
 * agent session is active is flagged `suspect`. `dnr orders show`, the board and Stop show it.
 */
import type { Grant } from '@dnr/schemas';
import type { Store } from '@dnr/store';
import { isAgentHost, KIRO_AGENT_VARS, type Proc, processChain } from './ancestry';

export async function grantOrigin(input: {
  via: NonNullable<Grant['origin']>['via'];
  store: Store;
  env: NodeJS.ProcessEnv;
  now: number;
  sessionTtlMinutes: number;
  isTTY?: boolean;
  chain?: Proc[];
}): Promise<NonNullable<Grant['origin']>> {
  const markers: string[] = [];
  for (const k of KIRO_AGENT_VARS) if (input.env[k]) markers.push(`env:${k}`);
  const chain = input.chain ?? (input.via === 'ask' ? [] : processChain());
  for (const p of chain)
    if (isAgentHost(p.command))
      markers.push(`ancestor:${(p.command.split(/\s+/)[0] ?? '').split('/').pop()}`);
  if (input.isTTY === false) markers.push('no-tty');
  if (input.via !== 'ask') {
    for (const s of await input.store.sessions.list().catch(() => [])) {
      if (input.now - Date.parse(s.last_seen_at) <= input.sessionTtlMinutes * 60_000)
        markers.push(`active-session:${s.session_key.slice(0, 8)}`);
    }
  }
  return { via: input.via, suspect: markers.length > 0, markers };
}
