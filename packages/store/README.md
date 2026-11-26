# @dnr/store

Filesystem state for DNR (plan §5.7, §7): orders, grants, sessions, `events.jsonl`, `hook.log` and config. Every write goes to a temp file and is renamed into place. Every read-modify-write holds an `O_EXCL` lock file (`<file>.lock`). A lock older than 10 s, or one whose owning pid is gone, is broken. Everything is validated with the `@dnr/schemas` Zod schemas.

## Quick start

```ts
import { openStore } from '@dnr/store';
const store = openStore(repoRoot);              // honours DNR_STATE_DIR, DNR_ORDERS, DNR_CONFIG, DNR_RECORD_PATH
const { config } = await store.loadConfig();    // DNR_CONFIG → <repo>/.dnr/config.json → defaults; DNR_MODE, DNR_THRESHOLD override
const orders = await store.orders.list();
await store.orders.approve('dnr-43933a1dca', 'builder');
```

## Layout

| Path | Contents |
|---|---|
| `$DNR_ORDERS` (default `<repo>/.dnr/orders`) | `<id>.json`, one `Order` each (committed) |
| `$DNR_CONFIG` (default `<repo>/.dnr/config.json`) | `DnrConfig` (committed) |
| `$DNR_STATE_DIR` (default `<repo>/.dnr`) | everything below (ignored) |
| `sessions/<session_key>.json` | `Session` |
| `grants/<order_id>.<session_key>.json` | `Grant`; `<order_id>.pending.json` until a session claims it |
| `events.jsonl` | `EventRecord` lines (record mode writes to `$DNR_RECORD_PATH` when set) |
| `hook.log` | one line per internal error (`error_open`) or debug note |
| `cache/orders-index.json` | file → orders coverage index used by the hook's fast path |
| `board.json` | `{port, origin, pid}` written by `dnr board` while it runs (guard-shell R7 reads it) |
| `candidates.json` | `ScanCandidate[]` from `dnr scan` |
| `drafts/` | `dnr draft` cache |

## API

### `openStore(repoRoot, { env?, ordersDir?, stateDir?, configFile? }): Store`
- `paths: DnrPaths`: `repoRoot, stateDir, ordersDir, configFile, configFromEnv, eventsFile, recordFile, hookLog, sessionsDir, grantsDir, cacheDir, draftsDir, boardFile, candidatesFile`.
- `orders: OrderStore`, `sessions: SessionStore`, `grants: GrantStore` (below).
- `loadConfig(): Promise<{ config, source: 'env'|'repo'|'defaults', path }>` throws `ConfigError` on an invalid file, or when `DNR_CONFIG` names a missing file.
- `ordersHash(): string` hashes the orders dir, the config file and `.kiro/hooks/dnr-*.json` (the Stop order-set check, §5.11).
- `appendEvent(record, { record? })` and `readEvents({ order?, hook? })`.
- `log(line)` appends to `hook.log` and never throws.

Every order mutation made through `store.orders` sets `orders_hash` on every live session. Changes made through a guarded `dnr` command or the board therefore never trip the Stop order-set check. Direct file edits still do.

### `OrderStore`
- `list(): Promise<Order[]>` and `load(): Promise<{ orders, invalid: {file, error}[] }>`
- `get(id): Promise<Order | null>`, `require(id)` (throws `OrderNotFoundError`), `put(order)` (validates, writes atomically), `remove(id)`
- `update(id, fn)` does a locked read-modify-write.
- `transition(id, to, by, at?)`, `approve(id, by)`, `retire(id, by)` and `unretire(id, by)` append history. They throw `TransitionError` (`name === 'TransitionError'`, mapped to 409) on an invalid move.
- `checkTransition(from, to): HistoryAction | null` is the transition table: draft→approved (`approved`), draft→retired and approved→retired (`retired`), retired→draft (`unretired`). Re-approval is needed before an unretired order enforces again.
- `editReason(id, reason, by, source = 'human')` appends `edited_reason` and keeps the status.
- `coverage(): Map<file, {id, status}[]>` is synchronous and cached by file size and mtime.

Effective status (`stale`, `relanded`) and the snapshot rebase for re-approval need git and the parser, so they live in `@dnr/hook` (`effectiveStatus`, `reapproveOrder`), not here.

### `SessionStore`
- `sessionKeyFor(session_id, cwd): { key, source }` returns `sha256(session_id)`, or `cwd-<sha256(realpath(cwd))>` as the fallback.
- `get(key)`, `put(session)`, `delete(key)`, `list()`, `with(key, fn)` (locked), `refreshOrdersHash(hash)`.
- `newSession({ key, baseline_tree, orders_hash, at })`, `sessionExpired(s, ttlMinutes)` (fallback sessions only), `sessionIdle(s, ttlMinutes)` (gc).

### `GrantStore`
- `create({ order_id, kind: 'allow_once'|'ask', session_key | null, granted_by, ttl_ms = 1h, at? })`: a `null` session key writes a pending grant.
- `claimPending(sessionKey)` binds unexpired pending grants to the session that sees them first (the hook does this on every event).
- `list(orderId?)`, `get(orderId, sessionKey)`, `applying(session)`.
- `grantApplies(grant, session, now?)`: the grant is for this session and either unexpired or already used in it (R9).
- `recordUse(orderId, sessionKey, { event_id, kind: 'write'|'commit'|'backstop' }, blobs)` and `commitGrant(orderId, stagedBlobs)` (the pre-commit blob rule).
- `gc()` removes expired, unused grants.

### Other helpers
`nowMs()` and `nowIso()` honour `DNR_NOW` (an ISO date or epoch ms). `parseTtl('1h')` also accepts `30m`, `90s`, `2d` and bare seconds. The low-level helpers are `withLock(path, fn)`, `writeFileAtomic`, `writeJsonAtomic` and `readJsonOrNull`.
