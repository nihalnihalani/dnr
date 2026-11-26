/**
 * Scorable units and their qualnames (§5.2 Python, §5.15 TypeScript/JavaScript).
 *
 * Units: module functions; methods at any depth (`Outer.Inner.m`); `Cls.<body>`; `<module>`.
 * Decorators belong to the unit they decorate; nested closures belong to the enclosing unit;
 * a name repeated in one scope gets `#2`, `#3`, … on later copies.
 */
import { childrenOf, type GrammarId, type SyntaxNode } from './syntax';

export type UnitKindTag = 'function' | 'body' | 'module';

export interface UnitSpan {
  qualname: string;
  tag: UnitKindTag;
  /** UTF-16 offsets of the unit's whole span (decorators included). */
  start: number;
  end: number;
  /** 0-based inclusive rows. */
  startRow: number;
  endRow: number;
  /** Extra spans owned by this unit (TS overload signatures that join their implementation). */
  extra: Array<{ start: number; end: number; startRow: number; endRow: number }>;
}

export const MODULE_UNIT = '<module>';
export const BODY_UNIT = '<body>';
export const DEFAULT_UNIT = '<default>';

class Scope {
  private counts = new Map<string, number>();
  constructor(readonly prefix: string) {}
  /** Next deduplicated name for `name` in this scope (`f`, `f#2`, …). */
  take(name: string): string {
    const n = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, n);
    return n === 1 ? name : `${name}#${n}`;
  }
  qual(local: string): string {
    return this.prefix ? `${this.prefix}.${local}` : local;
  }
}

function span(qualname: string, tag: UnitKindTag, from: SyntaxNode, to: SyntaxNode = from): UnitSpan {
  return {
    qualname,
    tag,
    start: from.startIndex,
    end: to.endIndex,
    startRow: from.startPosition.row,
    endRow: to.endPosition.row,
    extra: [],
  };
}

/** Extract the unit spans of a parsed file. The `<module>` unit is always first. */
export function unitSpans(root: SyntaxNode, grammar: GrammarId): UnitSpan[] {
  const units: UnitSpan[] = [
    {
      qualname: MODULE_UNIT,
      tag: 'module',
      start: root.startIndex,
      end: root.endIndex,
      startRow: 0,
      endRow: root.endPosition.row,
      extra: [],
    },
  ];
  if (grammar === 'python') pyWalk(root, new Scope(''), units);
  else tsWalkStatements(childrenOf(root), new Scope(''), units);
  return units;
}

// ---------------------------------------------------------------- Python

function pyWalk(n: SyntaxNode, scope: Scope, out: UnitSpan[]): void {
  for (const c of childrenOf(n)) {
    let def = c;
    if (c.type === 'decorated_definition') def = c.childForFieldName('definition') ?? c;
    if (def.type === 'function_definition') {
      const name = def.childForFieldName('name');
      const local = scope.take(name ? textOf(name) : '<anon>');
      out.push(span(scope.qual(local), 'function', c));
      // nested functions and classes are closures of this unit: do not descend
      continue;
    }
    if (def.type === 'class_definition') {
      const name = def.childForFieldName('name');
      const local = scope.take(name ? textOf(name) : '<anon>');
      const q = scope.qual(local);
      out.push(span(`${q}.${BODY_UNIT}`, 'body', c));
      const body = def.childForFieldName('body');
      if (body) pyWalk(body, new Scope(q), out);
      continue;
    }
    pyWalk(c, scope, out);
  }
}

// ---------------------------------------------------------------- TypeScript / TSX

const FN_VALUE = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_DECL = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const FN_DECL = new Set(['function_declaration', 'generator_function_declaration']);
const FN_SIG = new Set(['function_signature']);
const NAMESPACE = new Set(['internal_module', 'module']);

function tsWalkStatements(stmts: SyntaxNode[], scope: Scope, out: UnitSpan[]): void {
  const pendingSigs = new Map<string, SyntaxNode[]>();
  for (const stmt of stmts) tsStatement(stmt, stmt, scope, out, pendingSigs);
  flushSigs(pendingSigs, scope, out);
}

function flushSigs(pending: Map<string, SyntaxNode[]>, scope: Scope, out: UnitSpan[]): void {
  // Overload signatures with no implementation become their own unit.
  for (const [name, sigs] of pending) {
    const first = sigs[0];
    const last = sigs[sigs.length - 1];
    if (first && last) out.push(span(scope.qual(scope.take(name)), 'function', first, last));
  }
  pending.clear();
}

/** `outer` is the node whose span the unit takes (the export statement when exported). */
function tsStatement(
  outer: SyntaxNode,
  n: SyntaxNode,
  scope: Scope,
  out: UnitSpan[],
  pendingSigs: Map<string, SyntaxNode[]>,
): void {
  const t = n.type;
  if (t === 'export_statement') {
    const decl = n.childForFieldName('declaration');
    if (decl) {
      tsStatement(outer, decl, scope, out, pendingSigs);
      return;
    }
    const value = n.childForFieldName('value');
    if (value && isDefaultExport(n)) {
      if (FN_VALUE.has(value.type) || FN_DECL.has(value.type)) {
        const nm = value.childForFieldName('name');
        const local = scope.take(nm ? textOf(nm) : DEFAULT_UNIT);
        out.push(span(scope.qual(local), 'function', outer));
        return;
      }
      if (CLASS_DECL.has(value.type)) {
        tsClass(outer, value, scope, out);
        return;
      }
    }
    // `export default function () {}` may surface as a declaration without a name in some grammars
    for (const c of childrenOf(n)) {
      if (FN_DECL.has(c.type) || CLASS_DECL.has(c.type)) {
        tsStatement(outer, c, scope, out, pendingSigs);
        return;
      }
    }
    return;
  }
  if (FN_SIG.has(t)) {
    const nm = n.childForFieldName('name');
    if (nm) {
      const name = textOf(nm);
      const list = pendingSigs.get(name) ?? [];
      list.push(outer);
      pendingSigs.set(name, list);
    }
    return;
  }
  if (FN_DECL.has(t)) {
    const nm = n.childForFieldName('name');
    const name = nm ? textOf(nm) : DEFAULT_UNIT;
    const local = scope.take(name);
    const u = span(scope.qual(local), 'function', outer);
    const sigs = pendingSigs.get(name);
    if (sigs) {
      for (const s of sigs) u.extra.push(rangeOf(s));
      pendingSigs.delete(name);
    }
    out.push(u);
    return;
  }
  if (CLASS_DECL.has(t)) {
    tsClass(outer, n, scope, out);
    return;
  }
  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const decls = childrenOf(n).filter((c) => c.type === 'variable_declarator');
    for (const d of decls) {
      const value = d.childForFieldName('value');
      const nm = d.childForFieldName('name');
      if (!value || !nm || nm.type !== 'identifier') continue;
      if (FN_VALUE.has(value.type)) {
        const local = scope.take(textOf(nm));
        out.push(span(scope.qual(local), 'function', decls.length === 1 ? outer : d));
      } else if (CLASS_DECL.has(value.type)) {
        tsClass(decls.length === 1 ? outer : d, value, scope, out, textOf(nm));
      }
    }
    return;
  }
  if (t === 'expression_statement') {
    const inner = n.child(0);
    if (inner && NAMESPACE.has(inner.type)) {
      tsStatement(outer, inner, scope, out, pendingSigs);
      return;
    }
    return;
  }
  if (NAMESPACE.has(t)) {
    const nm = n.childForFieldName('name');
    const body = n.childForFieldName('body');
    if (nm && body) {
      // Namespace members are qualified by the namespace (`Ns.f`); its loose statements stay in <module>.
      const ns = scope.take(textOf(nm));
      tsWalkStatements(childrenOf(body), new Scope(scope.qual(ns)), out);
    }
    return;
  }
  if (t === 'ambient_declaration') {
    for (const c of childrenOf(n)) tsStatement(outer, c, scope, out, pendingSigs);
  }
}

function isDefaultExport(n: SyntaxNode): boolean {
  return childrenOf(n).some((c) => c.type === 'default');
}

const MEMBER_FN = new Set(['method_definition']);
const MEMBER_SIG = new Set(['method_signature', 'abstract_method_signature']);

function tsClass(
  outer: SyntaxNode,
  cls: SyntaxNode,
  scope: Scope,
  out: UnitSpan[],
  fallbackName?: string,
): void {
  const nm = cls.childForFieldName('name');
  const local = scope.take(nm ? textOf(nm) : (fallbackName ?? DEFAULT_UNIT));
  const q = scope.qual(local);
  out.push(span(`${q}.${BODY_UNIT}`, 'body', outer));
  const body = cls.childForFieldName('body');
  if (!body) return;
  const inner = new Scope(q);
  const pendingSigs = new Map<string, SyntaxNode[]>();
  let decorators: SyntaxNode[] = [];
  for (const m of childrenOf(body)) {
    if (m.type === 'decorator') {
      decorators.push(m);
      continue;
    }
    const start = decorators[0] ?? m;
    decorators = [];
    if (MEMBER_SIG.has(m.type)) {
      const mn = m.childForFieldName('name');
      if (mn) {
        const list = pendingSigs.get(textOf(mn)) ?? [];
        list.push(start);
        list.push(m);
        pendingSigs.set(textOf(mn), list);
      }
      continue;
    }
    let isFn = MEMBER_FN.has(m.type);
    if (!isFn && (m.type === 'public_field_definition' || m.type === 'field_definition')) {
      const v = m.childForFieldName('value');
      isFn = !!v && FN_VALUE.has(v.type);
    }
    if (!isFn) continue;
    const mn = m.childForFieldName('name') ?? m.childForFieldName('property');
    const name = mn ? textOf(mn) : '<anon>';
    const u = span(inner.qual(inner.take(name)), 'function', start, m);
    const sigs = pendingSigs.get(name);
    if (sigs) {
      for (let i = 0; i + 1 < sigs.length; i += 2) {
        const a = sigs[i] as SyntaxNode;
        const b = sigs[i + 1] as SyntaxNode;
        u.extra.push({
          start: a.startIndex,
          end: b.endIndex,
          startRow: a.startPosition.row,
          endRow: b.endPosition.row,
        });
      }
      pendingSigs.delete(name);
    }
    out.push(u);
  }
}

function rangeOf(n: SyntaxNode) {
  return { start: n.startIndex, end: n.endIndex, startRow: n.startPosition.row, endRow: n.endPosition.row };
}

function textOf(n: SyntaxNode): string {
  return n.text;
}
