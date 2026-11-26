/**
 * A tiny program model rendered to Python or TypeScript, used by the property tests.
 *
 * A module is a list of functions plus one optional class. Every function and every body
 * statement carries a change status: `keep` (in every state), `ins` (added by commit C) or
 * `del` (removed by C). Rendering with a set of applied change ids gives any state between
 * the post-revert snapshot (nothing applied) and C (everything applied).
 */

export type Lang = 'python' | 'typescript';

export type Expr =
  | { t: 'atom'; v: string }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'call'; fn: string; args: Expr[] }
  | { t: 'attr'; obj: string; name: string };

export type Stmt =
  | { t: 'assign'; x: string; e: Expr }
  | { t: 'aug'; x: string; op: '+' | '-' | '*'; e: Expr }
  | { t: 'ret'; e: Expr }
  | { t: 'call'; e: Expr }
  | { t: 'if'; cond: Expr; body: Stmt[] }
  | { t: 'for'; x: string; iter: string; body: Stmt[] };

export type Status = 'keep' | 'ins' | 'del';

export interface Entry {
  id: string;
  status: Status;
  stmt: Stmt;
}

export interface Fn {
  id: string;
  name: string;
  params: string[];
  status: Status;
  decorator: string | null;
  body: Entry[];
}

export interface Cls {
  name: string;
  attrs: Stmt[];
  methods: Fn[];
}

export interface Mod {
  header: Stmt[];
  fns: Fn[];
  cls: Cls | null;
}

export interface Style {
  /** Spaces between tokens (1–3). */
  gap: number;
  indent: number;
  blankLines: number;
  /** Insert a comment line before every k-th statement (0 = none). */
  commentEvery: number;
  trailingComments: boolean;
}

export const DEFAULT_STYLE: Style = {
  gap: 1,
  indent: 4,
  blankLines: 2,
  commentEvery: 0,
  trailingComments: false,
};

/** Every change id of a module (ins/del statements and functions). */
export function changeIds(m: Mod): string[] {
  const out: string[] = [];
  const visit = (f: Fn) => {
    if (f.status !== 'keep') out.push(f.id);
    for (const e of f.body) if (e.status !== 'keep') out.push(e.id);
  };
  m.fns.forEach(visit);
  m.cls?.methods.forEach(visit);
  return out;
}

/** Is the item present in the state where `applied` changes have been made? */
function present(status: Status, id: string, applied: ReadonlySet<string>): boolean {
  if (status === 'keep') return true;
  return status === 'ins' ? applied.has(id) : !applied.has(id);
}

// ------------------------------------------------------------------ token rendering

function exprTokens(e: Expr, lang: Lang): string[] {
  switch (e.t) {
    case 'atom':
      return [e.v];
    case 'bin':
      return ['(', ...exprTokens(e.l, lang), e.op, ...exprTokens(e.r, lang), ')'];
    case 'call': {
      const out = [e.fn, '('];
      e.args.forEach((a, i) => {
        if (i > 0) out.push(',');
        out.push(...exprTokens(a, lang));
      });
      out.push(')');
      return out;
    }
    case 'attr':
      return [e.obj, '.', e.name];
  }
}

type Line = { depth: number; tokens: string[] };

function stmtLines(s: Stmt, depth: number, lang: Lang): Line[] {
  const semi = lang === 'typescript' ? [';'] : [];
  switch (s.t) {
    case 'assign':
      return [{ depth, tokens: [s.x, '=', ...exprTokens(s.e, lang), ...semi] }];
    case 'aug':
      return [{ depth, tokens: [s.x, `${s.op}=`, ...exprTokens(s.e, lang), ...semi] }];
    case 'ret':
      return [{ depth, tokens: ['return', ...exprTokens(s.e, lang), ...semi] }];
    case 'call':
      return [{ depth, tokens: [...exprTokens(s.e, lang), ...semi] }];
    case 'if': {
      const body = s.body.flatMap((b) => stmtLines(b, depth + 1, lang));
      if (lang === 'python') return [{ depth, tokens: ['if', ...exprTokens(s.cond, lang), ':'] }, ...body];
      return [
        { depth, tokens: ['if', '(', ...exprTokens(s.cond, lang), ')', '{'] },
        ...body,
        { depth, tokens: ['}'] },
      ];
    }
    case 'for': {
      const body = s.body.flatMap((b) => stmtLines(b, depth + 1, lang));
      if (lang === 'python') return [{ depth, tokens: ['for', s.x, 'in', s.iter, ':'] }, ...body];
      return [
        { depth, tokens: ['for', '(', 'const', s.x, 'of', s.iter, ')', '{'] },
        ...body,
        { depth, tokens: ['}'] },
      ];
    }
  }
}

function fnLines(f: Fn, depth: number, lang: Lang, applied: ReadonlySet<string>, method: boolean): Line[] {
  const body = f.body
    .filter((e) => present(e.status, e.id, applied))
    .flatMap((e) => stmtLines(e.stmt, depth + 1, lang));
  const params: string[] = [];
  const all = method && lang === 'python' ? ['self', ...f.params] : f.params;
  all.forEach((p, i) => {
    if (i > 0) params.push(',');
    params.push(p);
  });
  const out: Line[] = [];
  // TS has no decorators on function declarations
  if (f.decorator && (lang === 'python' || method)) out.push({ depth, tokens: ['@', f.decorator] });
  if (lang === 'python') {
    out.push({ depth, tokens: ['def', f.name, '(', ...params, ')', ':'] });
    out.push(...(body.length ? body : [{ depth: depth + 1, tokens: ['pass'] }]));
  } else {
    out.push({ depth, tokens: [...(method ? [] : ['function']), f.name, '(', ...params, ')', '{'] });
    out.push(...body);
    out.push({ depth, tokens: ['}'] });
  }
  return out;
}

/** Render the module state with the given applied change ids. */
export function render(
  m: Mod,
  lang: Lang,
  applied: ReadonlySet<string>,
  style: Style = DEFAULT_STYLE,
): string {
  const blocks: Line[][] = [];
  if (m.header.length) blocks.push(m.header.flatMap((s) => stmtLines(s, 0, lang)));
  for (const f of m.fns)
    if (present(f.status, f.id, applied)) blocks.push(fnLines(f, 0, lang, applied, false));
  if (m.cls) {
    const c = m.cls;
    const lines: Line[] = [];
    lines.push({ depth: 0, tokens: lang === 'python' ? ['class', c.name, ':'] : ['class', c.name, '{'] });
    for (const a of c.attrs) {
      const l = stmtLines(a, 1, lang);
      // TS class fields: `x = expr;` is valid as a field declaration
      lines.push(...l);
    }
    for (const meth of c.methods)
      if (present(meth.status, meth.id, applied)) lines.push(...fnLines(meth, 1, lang, applied, true));
    if (
      lang === 'python' &&
      c.attrs.length === 0 &&
      !c.methods.some((x) => present(x.status, x.id, applied))
    ) {
      lines.push({ depth: 1, tokens: ['pass'] });
    }
    if (lang === 'typescript') lines.push({ depth: 0, tokens: ['}'] });
    blocks.push(lines);
  }
  const sep = ' '.repeat(Math.max(1, style.gap));
  const ind = ' '.repeat(style.indent);
  const comment = lang === 'python' ? '#' : '//';
  let n = 0;
  const text = blocks
    .map((b) =>
      b
        .map((l) => {
          n++;
          const pre =
            style.commentEvery > 0 && n % style.commentEvery === 0
              ? `${ind.repeat(l.depth)}${comment} note ${n}\n`
              : '';
          const trail = style.trailingComments && n % 3 === 0 ? `  ${comment} t${n}` : '';
          return `${pre}${ind.repeat(l.depth)}${l.tokens.join(sep)}${trail}`;
        })
        .join('\n'),
    )
    .join('\n'.repeat(style.blankLines + 1));
  return `${text}\n`;
}

export function fileName(base: string, lang: Lang): string {
  return `${base}.${lang === 'python' ? 'py' : 'ts'}`;
}
