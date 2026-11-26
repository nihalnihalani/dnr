/**
 * fast-check arbitraries for the property tests (plan §12.1 P1–P17).
 */
import fc from 'fast-check';
import type { Entry, Expr, Fn, Mod, Status, Stmt, Style } from './program';

export const IDENTS = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'items', 'total', 'limit', 'name'];
export const CALLEES = ['g0', 'g1', 'g2', 'len', 'max', 'build'];
export const ATTRS = ['price', 'count', 'parent', 'value'];
export const OPS = ['+', '-', '*', '<', '>', '=='];

export const atom: fc.Arbitrary<Expr> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...IDENTS).map((v): Expr => ({ t: 'atom', v })) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 9 }).map((n): Expr => ({ t: 'atom', v: String(n) })) },
  { weight: 1, arbitrary: fc.constantFrom("'a'", "'b'", "'key'").map((v): Expr => ({ t: 'atom', v })) },
);

export const expr: fc.Arbitrary<Expr> = fc.oneof(
  { weight: 3, arbitrary: atom },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('bin' as const), op: fc.constantFrom(...OPS), l: atom, r: atom }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('call' as const),
      fn: fc.constantFrom(...CALLEES),
      args: fc.array(atom, { maxLength: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('attr' as const),
      obj: fc.constantFrom(...IDENTS),
      name: fc.constantFrom(...ATTRS),
    }),
  },
);

const ident = fc.constantFrom(...IDENTS);
const callExpr = fc.record({
  t: fc.constant('call' as const),
  fn: fc.constantFrom(...CALLEES),
  args: fc.array(atom, { maxLength: 3 }),
});

export const simpleStmt: fc.Arbitrary<Stmt> = fc.oneof(
  fc.record({ t: fc.constant('assign' as const), x: ident, e: expr }),
  fc.record({
    t: fc.constant('aug' as const),
    x: ident,
    op: fc.constantFrom('+' as const, '-' as const, '*' as const),
    e: expr,
  }),
  fc.record({ t: fc.constant('ret' as const), e: expr }),
  fc.record({ t: fc.constant('call' as const), e: callExpr }),
);

export const stmt: fc.Arbitrary<Stmt> = fc.oneof(
  { weight: 4, arbitrary: simpleStmt },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('if' as const),
      cond: expr,
      body: fc.array(simpleStmt, { minLength: 1, maxLength: 2 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('for' as const),
      x: ident,
      iter: ident,
      body: fc.array(simpleStmt, { minLength: 1, maxLength: 2 }),
    }),
  },
);

export interface ModOptions {
  /** Statuses a changed function may give its statements (default: ins and del). */
  statuses?: readonly Status[];
  /** Allow whole functions added (`ins`) or removed (`del`) by C. */
  fnChanges?: readonly Status[];
}

function fnArb(id: string, name: string, opts: Required<ModOptions>): fc.Arbitrary<Fn> {
  const entry = (i: number, changed: boolean): fc.Arbitrary<Entry> =>
    fc
      .record({
        status: changed
          ? fc.constantFrom<Status>('keep', 'keep', ...opts.statuses)
          : fc.constant<Status>('keep'),
        stmt,
      })
      .map((e) => ({ id: `${id}:${i}`, ...e }));
  return fc
    .record({
      changed: fc.boolean(),
      status: fc.constantFrom<Status>('keep', 'keep', 'keep', ...opts.fnChanges),
      params: fc.subarray(['a', 'b', 'c'], { minLength: 0, maxLength: 3 }),
      decorator: fc.option(fc.constantFrom('cached', 'staticmethod_like'), { nil: null }),
      n: fc.integer({ min: 1, max: 5 }),
    })
    .chain(({ changed, status, params, decorator, n }) =>
      fc
        .tuple(...Array.from({ length: n }, (_, i) => entry(i, changed && status === 'keep')), stmt)
        .map((parts): Fn => {
          const body = parts.slice(0, n) as Entry[];
          // every function keeps at least one statement so no state renders an empty body
          body.push({ id: `${id}:k`, status: 'keep', stmt: parts[n] as Stmt });
          return { id, name, params, status, decorator, body };
        }),
    );
}

/** A module with 2–4 functions and an optional class of 1–3 methods. */
export function modArb(options: ModOptions = {}): fc.Arbitrary<Mod> {
  const opts: Required<ModOptions> = {
    statuses: options.statuses ?? ['ins', 'del'],
    fnChanges: options.fnChanges ?? ['ins', 'del'],
  };
  return fc
    .record({
      nf: fc.integer({ min: 2, max: 4 }),
      nm: fc.integer({ min: 0, max: 3 }),
      header: fc.array(
        simpleStmt.filter((s) => s.t === 'assign'),
        { maxLength: 2 },
      ),
    })
    .chain(({ nf, nm, header }) =>
      fc
        .record({
          fns: fc.tuple(...Array.from({ length: nf }, (_, i) => fnArb(`f${i}`, `func_${i}`, opts))),
          methods:
            nm === 0
              ? fc.constant([] as Fn[])
              : fc.tuple(...Array.from({ length: nm }, (_, i) => fnArb(`m${i}`, `meth_${i}`, opts))),
          // at least one attribute, so no state renders a placeholder `pass` that C would remove
          attrs: fc.array(
            simpleStmt.filter((s) => s.t === 'assign'),
            { minLength: 1, maxLength: 2 },
          ),
        })
        .map(
          ({ fns, methods, attrs }): Mod => ({
            header,
            fns: [...fns],
            cls: methods.length
              ? { name: 'Widget', attrs, methods: methods.map((m) => ({ ...m, decorator: null })) }
              : null,
          }),
        ),
    );
}

export const styleArb: fc.Arbitrary<Style> = fc.record({
  gap: fc.integer({ min: 1, max: 3 }),
  indent: fc.constantFrom(2, 4, 8),
  blankLines: fc.integer({ min: 1, max: 3 }),
  commentEvery: fc.integer({ min: 0, max: 4 }),
  trailingComments: fc.boolean(),
});

/** Fresh identifiers that never occur in generated programs (used for "touches none of the order's tokens"). */
export const freshIdent = fc.integer({ min: 0, max: 999 }).map((n) => `zz_fresh_${n}`);

export const freshStmt: fc.Arbitrary<Stmt> = fc
  .tuple(freshIdent, freshIdent)
  .map(([x, y]): Stmt => ({ t: 'assign', x, e: { t: 'atom', v: y } }));

/** A random 32-bit seed for the mulberry32 PRNG. */
export const seedArb = fc.integer({ min: 0, max: 0x7fffffff });
