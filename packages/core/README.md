# @dnr/core

The isomorphic DNR match engine (plan §5). It has no `node:*` imports, so the hook, the CLI and the Playground all run the same code. Types come from `@dnr/schemas`. A parser comes from `@dnr/grammar`: `loadGrammarsNode()` from `@dnr/grammar/node` in Node, or `loadGrammarsBrowser(urls)` from `@dnr/grammar` in a browser. Either one satisfies `ParserProvider`.

Core never touches git or the filesystem. Callers pass file texts in and apply the returned effects themselves.

## Quick start

```ts
import { loadGrammarsNode } from '@dnr/grammar/node';
import { buildOrder, createState, decide, UnitCache } from '@dnr/core';

const parser = await loadGrammarsNode();
const r = buildOrder({ provider: parser, original_sha: C, revert_sha: R, snapshot_sha: R,
  files: [{ path, before /* C^ */, after /* C */, post_revert /* R */ }], links, at: new Date().toISOString() });
if (!r.ok) throw new Error(r.skip_reason);            // 'no-unit-change'

const cache = new UnitCache(parser);                    // share one cache across states
const baseline = createState({ [path]: baselineText }, cache);
const proposed = createState({ [path]: proposedText }, cache);
const { decision, effects } = decide({
  target: path, orders: [{ order: { ...r.order, status: 'approved' }, material: r.material }],
  baseline, current: baseline, proposed, warned: session.warned, grantApplies: (id) => grantApplies(id),
});
```

## API

### Grammar and syntax (§5.15)
- `grammarForPath(path: string): GrammarId | null` maps `.py` to `python`; `.ts/.mts/.cts` to `typescript` (`*.d.ts` returns null and is not scored); `.tsx/.js/.jsx/.mjs/.cjs` to `tsx`.
- `interface ParserProvider { parse(grammar: GrammarId, text: string): SyntaxTree }`
- `SyntaxNode` and `SyntaxTree` are minimal structural types. web-tree-sitter's `Node` and `Tree` satisfy them.

### Tokens and weights (§5.1, §5.15)
- `tokenize(provider, grammar, text): Token[]` and `tokenizeTree(root, grammar, text): Token[]`. `Token = { key, start, end, row, inError }`.
- `tokenWeight(key, grammar): 0 | 1`, `weightOf(tokens, grammar): number` (that is, w()), `weightSet(grammar)`, `NORMALIZER_VERSION`.
- `unitWeights(orderUnit): { wA, wR }` and `orderWeight(order): number`. Use these, not `A.length`: A and R include weight-0 tokens. For example, dnr-43933a1dca has |A| = 31 but w(A) = 16.
- `TYPE_ARG_OPEN` (`‹`) and `TYPE_ARG_CLOSE` (`›`) are the token keys of TS `<` and `>` inside type arguments and type parameters.

### Units and qualnames (§5.2–5.3)
- `extractUnits(provider, path, text): FileUnits | null` returns `{ path, grammar, units: Map<qualname, Unit>, spans, hasError }`. `Unit = { qualname, tokens, weight, degraded, startLine, endLine }`.
- `qualnames(provider, path, text, lineRanges: [start, end][]): string[]` maps each changed line (1-based) to the smallest unit that contains it.
- `qualnamesForLines(fileUnits, lines)` and `qualnameAtLine(fileUnits, line)` do the same mapping on units that are already extracted.
- `MODULE_UNIT` (`<module>`), `BODY_UNIT` (`<body>`), `DEFAULT_UNIT` (`<default>`), `unitSpans(root, grammar)`.

### Diff and multisets
- `diffTokens(before, after): { A, R }` wraps jsdiff `diffArrays`. `sameTokens(a, b)`.
- `multiset(xs)`, `intersectionWeight(x, y, grammar)` (w(X∩Y), counted with repeats), `jaccard(x, y)` (weighted multiset Jaccard), `shingles3(tokens, grammar)` (S3 over weight-1 tokens).

### Building orders (§5.3)
- `buildOrder(input: BuildOrderInput): { ok: true; order; material; changes } | { ok: false; skip_reason: 'no-unit-change' }`. The input is `{ provider, original_sha, revert_sha, snapshot_sha, files: {path, before, after, post_revert}[], links, tickets?, reason?, reason_source?, status? ('draft'), at, by? }`. The output is deterministic: files are sorted by path.
- `extractUnitChanges(provider, {path, before, after}): UnitChange[]` returns the changed units of one file (`{ file, qualname, grammar, kind, A, R, before, after }`), with formatting-only units skipped. Mining's rule E5 uses it.
- `changedLines(before, after): { old: number[]; new: number[] }` gives the `git diff -U0` line sets.
- Test paths are never order units. `buildOrder({ testGlobs })` and `extractUnitChanges(p, f, { testGlobs })` default to `DEFAULT_TEST_GLOBS` (config `test_globs`). Use `isTestPath(path, globs)` and `matchesGlob(path, glob)` to check a path yourself.
- `orderId(revertSha | null, originalSha)`, `unitHash(tokens)` (the `post_revert_hash`), `sha256Hex(str)`.
- `materialFromTexts(provider, order, cText(file), snapshotText(file)): Map<unitKey, {C, PR}>` rebuilds the order material from `c_state_ref` and snapshot texts.

### States
- `createState(source: Map | Record | (path) => string | null, providerOrCache): StateView` and `overlayState(base, overrides, cache)`.
- `StateView = { text(path): string | null; units(path): FileUnits | null }`. `UnitCache(provider)` memoises parses by `(path, text)`.

### Scoring (§5.5, §5.6, §5.16)
- `scoreOrder(order, baseline, proposed, { config?, material?, searchFiles?, computeProx? }): OrderScore` scores the whole order. `OrderScore` holds `edit`, `wA/wR/iA/iR`, `two_sided`, `small`, `degraded`, `missing`, `prox`, `edit_fires`, `prox_fires`, `matched` and `fired_by`, plus a per-unit `units[]` (with `proposed: 'present' | 'empty' | 'relocated' | 'missing'` and `relocated_to`). `matched` does not account for stale. That is the caller's input.
- `matchState(order, snapshot, state, opts)` is match(state) for the crossing rule.
- `isCrossing(order, snapshot, parent, next, opts): { crossing, parent, next }`.
- `proxUnit(C, PR, baseline, candidates, grammar): number` is prox_u, which is never negative.
- `relocateUnit(unit, material, state, searchFiles, floor, exclude?)` and `fingerprintsOf(order, material)` implement the fingerprint index.
- `matchConfig(partial)` and `DEFAULT_MATCH_CONFIG` give `threshold 0.6, side_min 0.3, min_order_weight 8, prox_enabled false, prox_threshold 0.5, fingerprint_floor 0.7`.

### Stale and re-landed (§5.9)
- `staleReport(order, snapshot, head, { material?, searchFiles?, fingerprintFloor? }): { stale, differing, total, lost, relocated }` and `isStale(...)`.
- `isRelanded(order, snapshot, head, opts)` and `relandedScore(...)`.

### Decide (§5.4)
- `decide(input: DecideInput): { decision: Decision; effects: { warn, grantsUsed }; scores }` checks the tiers in the order protect → match → warn → allow.
  - Input: `{ target, protected?, unknownTool?, orders: {order, stale?, relanded?, material?}[], baseline, current, proposed, searchFiles?, warned?, grantApplies?, config?: { ...MatchConfig, decision_format: 'deny'|'ask', mode: 'enforce'|'warn-only' }, now? }`.
  - Only `approved` orders are used. Stale and re-landed orders only warn.
  - A write to a file that no order covers takes the fast path (`fast_path: true`) and is not parsed.
  - A missing covered unit scores as unmatched (it does not cap the order); a degraded unit still caps it at warn (§5.1).
  - Outcomes: `deny_protected`, `block` or `ask`, `warn_block` (`effects.warn` = the order to add to `Session.warned`), `allow_grant` (match or warn tier; `effects.grantsUsed`), `warn_pass`, `allow`.
  - Record and commit-enforce modes are left to the hook.
- `reasonLine(order)` returns `DNR: <reason> <revert URL>`.
- `blockMessage(order, decision, { qualnames?, threshold? })` returns the three-line stderr text from §6, at most 1,200 characters. To fit, it shortens the qualname list, then the links, then the reason. The "Do not … route around this block" line is never cut.

### Tool adapters (§5.8)
- `applyTool(tool, input, readCurrent(path)): ToolEffect` returns one of:
  - `{kind:'write', path, text}` (`text: null` means delete_file);
  - `{kind:'passthrough', reason}` (str_replace with zero or several matches);
  - `{kind:'unknown', path}` (warn tier);
  - `{kind:'none'}` (no path).
- It handles `fs_write`, including the legacy `command` dispatch (create, str_replace, append, insert), plus `str_replace`, `fs_append` and `delete_file`. Field names accept common aliases until spike S2 freezes them.

### Protect (§5.4)
- `protectedGlobs({ repoRoot, home?, ordersDir?, stateDir?, configFile? }): string[]`, `isProtected(absPath, globs, caseInsensitive = true)` and `normalizePath(p)`. The caller resolves realpaths.

## Decisions where the plan was open

1. **TS `<` and `>` in type arguments** get the token keys `‹` and `›`. Because of this, a token's weight depends only on its key, and stored A/R arrays can be re-weighted.
2. **Template literals with substitutions:** each run of fragments and escapes is one token, `` ` `` is weight 0, and `${` is weight 0 (it pairs with `}`, which is weight 0).
3. **Python f-strings** are one token, because §5.1 says each string literal is one token. Only the §5.15 TS rule splits template literals.
4. **Formatting-only:** a unit whose diff is all weight-0 tokens is skipped, the same as a pure whitespace or comment change.
5. **`parse-degraded`** is measured over the unit's token text: more than 20% of it under ERROR nodes.
6. **Missing `kind=modified` unit** (absent, not relocated): it is scored as *unmatched*. Its w(A)+w(R) stays in the denominator, both intersections are 0, and the order is flagged `missing` for reporting only. §5.5 says such a unit goes to "the warn tier" but does not say whether the whole order is capped. A whole-order cap would let an agent re-apply one unit and delete another to earn only a warn (review H6), so the cap is not used. A write that deletes a covered unit still changes it, so it warns when the order does not match.
7. **Warn tier "changes a covered unit"** is measured against the session state just before this write (token sequences), so a formatting-only write never warns.
8. **Proximity size(C_u)** is the number of weight-1 tokens in C_u. J(∅, ∅) = 0.
9. **Fingerprint search** treats typescript and tsx as one vocabulary and excludes the order's own unit locations.
