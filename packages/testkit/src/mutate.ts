/**
 * AST mutation operators (plan Phase 4, §9 mutation families). Each operator is defined on the
 * tree-sitter AST of the re-application (the files at C), and every mutant is checked for
 * validity: each written file must re-parse without ERROR or MISSING nodes and the mutant must
 * differ from its input.
 *
 * Seeds (one mutant per seed, so 5 mutants per family per revert):
 * - tune families (rename-locals, reorder-statements): 1000–1004
 * - held-out families (extract-helper, invert-condition): 2000–2004
 * - split-across-sessions: 3000–3004
 * - move-to-file: held-out 3100–3104 (P16), tune 3105–3109 (fingerprint floor)
 *
 * The PRNG for a mutant is keyed by `family:seed:revert_sha`, so a mutant depends only on
 * those three values and the input texts.
 */
import {
  changedLines,
  childrenOf,
  type GrammarId,
  grammarForPath,
  MODULE_UNIT,
  type ParserProvider,
  type SyntaxNode,
  unitSpans,
} from '@dnr/core';
import { keyedRng, pickOne, shuffle } from './prng';

export type MutationFamily =
  | 'rename-locals'
  | 'reorder-statements'
  | 'extract-helper'
  | 'invert-condition'
  | 'split-across-sessions'
  | 'move-to-file';

export const MUTATION_FAMILIES: readonly MutationFamily[] = [
  'rename-locals',
  'reorder-statements',
  'extract-helper',
  'invert-condition',
  'split-across-sessions',
  'move-to-file',
];

const range = (a: number) => [a, a + 1, a + 2, a + 3, a + 4];
export const SEEDS = {
  tune: range(1000),
  heldOut: range(2000),
  split: range(3000),
  moveHeldOut: range(3100),
  moveTune: range(3105),
} as const;

export const TUNE_FAMILIES: readonly MutationFamily[] = ['rename-locals', 'reorder-statements'];
export const HELD_OUT_FAMILIES: readonly MutationFamily[] = ['extract-helper', 'invert-condition'];

/** The seeds a family uses. `move-to-file` has two splits; pass `split` to choose. */
export function seedsFor(family: MutationFamily, split: 'tune' | 'held-out' = 'held-out'): readonly number[] {
  switch (family) {
    case 'rename-locals':
    case 'reorder-statements':
      return SEEDS.tune;
    case 'extract-helper':
    case 'invert-condition':
      return SEEDS.heldOut;
    case 'split-across-sessions':
      return SEEDS.split;
    case 'move-to-file':
      return split === 'tune' ? SEEDS.moveTune : SEEDS.moveHeldOut;
  }
}

export interface MutateFile {
  path: string;
  /** The file at C (the re-application being paraphrased). */
  text: string;
  /** The file at the post-revert snapshot (needed by split-across-sessions); null when absent there. */
  baseline?: string | null;
}

export interface MutateInput {
  provider: ParserProvider;
  family: MutationFamily;
  seed: number;
  /** Keys the PRNG together with family and seed. */
  revertSha: string;
  files: readonly MutateFile[];
  /** Order units to target (`{file, qualname}`); operators prefer function units. */
  units: ReadonlyArray<{ file: string; qualname: string }>;
}

export interface FileWrite {
  path: string;
  text: string | null;
}

export interface Mutant {
  family: MutationFamily;
  seed: number;
  /** Writes grouped by session. Every family has one session except split-across-sessions (two). */
  sessions: FileWrite[][];
  /** The unit the operator rewrote. */
  target: { file: string; qualname: string } | null;
  note: string;
}

type Edit = { start: number; end: number; text: string };

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function same(a: SyntaxNode | null | undefined, b: SyntaxNode): boolean {
  return !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

type Visit = (n: SyntaxNode, parent: SyntaxNode | null) => boolean | undefined;
/** Pre-order walk; return false from `visit` to skip a node's children. */
function walk(n: SyntaxNode, visit: Visit, parent: SyntaxNode | null = null): void {
  if (visit(n, parent) === false) return;
  for (const c of childrenOf(n)) walk(c, visit, n);
}

function parses(provider: ParserProvider, path: string, text: string): boolean {
  const g = grammarForPath(path);
  if (!g) return true;
  const tree = provider.parse(g, text);
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete?.();
  }
}

const PY_FN = new Set(['function_definition']);
const TS_FN = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'generator_function_declaration',
]);

/** The function node of a unit (by qualname), or null for `<module>` / `<body>` units. */
function unitFunction(root: SyntaxNode, grammar: GrammarId, qualname: string): SyntaxNode | null {
  const span = unitSpans(root, grammar).find((s) => s.qualname === qualname);
  if (span?.tag !== 'function') return null;
  const fnTypes = grammar === 'python' ? PY_FN : TS_FN;
  let found: SyntaxNode | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (n.endIndex <= span.start || n.startIndex >= span.end) return false;
    if (fnTypes.has(n.type) && n.startIndex >= span.start && n.endIndex <= span.end) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

function bodyOf(fn: SyntaxNode): SyntaxNode | null {
  return fn.childForFieldName('body');
}

interface Ctx {
  provider: ParserProvider;
  rng: () => number;
  path: string;
  text: string;
  grammar: GrammarId;
  root: SyntaxNode;
  qualname: string;
  fn: SyntaxNode | null;
  allPaths: ReadonlySet<string>;
}

type OpResult = { writes: FileWrite[]; note: string } | null;

// ------------------------------------------------------------------ identifiers

/** Identifier nodes that name a variable (not an attribute, keyword argument or definition name). */
function variableIdents(scope: SyntaxNode, grammar: GrammarId): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  walk(scope, (n, p) => {
    if (n.type !== 'identifier') return true;
    if (p) {
      if (p.type === 'attribute' && same(p.childForFieldName('attribute'), n)) return true;
      if (p.type === 'keyword_argument' && same(p.childForFieldName('name'), n)) return true;
      if (
        (p.type === 'function_definition' || p.type === 'class_definition') &&
        same(p.childForFieldName('name'), n)
      )
        return true;
      if (grammar !== 'python' && p.type === 'function_declaration' && same(p.childForFieldName('name'), n))
        return true;
    }
    out.push(n);
    return true;
  });
  return out;
}

function assignedLocals(fn: SyntaxNode, grammar: GrammarId): string[] {
  const body = bodyOf(fn);
  if (!body) return [];
  const names = new Set<string>();
  const blocked = new Set<string>();
  walk(body, (n) => {
    if (grammar === 'python') {
      if (n.type === 'assignment' || n.type === 'augmented_assignment') {
        const l = n.childForFieldName('left');
        if (l?.type === 'identifier') names.add(l.text);
      }
      if (n.type === 'for_statement') {
        const l = n.childForFieldName('left');
        if (l?.type === 'identifier') names.add(l.text);
      }
      if (n.type === 'global_statement' || n.type === 'nonlocal_statement') {
        for (const c of childrenOf(n)) if (c.type === 'identifier') blocked.add(c.text);
      }
    } else {
      if (n.type === 'variable_declarator') {
        const l = n.childForFieldName('name');
        if (l?.type === 'identifier') names.add(l.text);
      }
      if (n.type === 'shorthand_property_identifier' || n.type === 'shorthand_property_identifier_pattern')
        blocked.add(n.text);
    }
    return true;
  });
  const params = new Set<string>();
  const ps = fn.childForFieldName('parameters');
  if (ps)
    walk(ps, (n) => {
      if (n.type === 'identifier') params.add(n.text);
      return true;
    });
  return [...names].filter((x) => !blocked.has(x) && !params.has(x) && x !== 'self');
}

// ------------------------------------------------------------------ operators

function renameLocals(c: Ctx): OpResult {
  if (!c.fn) return null;
  const locals = assignedLocals(c.fn, c.grammar);
  if (locals.length === 0) return null;
  const chosen = shuffle(c.rng, locals).slice(0, 1 + Math.floor(c.rng() * locals.length));
  const suffix = Math.floor(c.rng() * 1e6).toString(36);
  const map = new Map(chosen.map((x, i) => [x, `${x}_r${i}${suffix}`]));
  const edits: Edit[] = [];
  for (const id of variableIdents(c.fn, c.grammar)) {
    const to = map.get(id.text);
    if (to) edits.push({ start: id.startIndex, end: id.endIndex, text: to });
  }
  if (edits.length === 0) return null;
  return {
    writes: [{ path: c.path, text: applyEdits(c.text, edits) }],
    note: `renamed ${[...map].map(([a, b]) => `${a}→${b}`).join(', ')}`,
  };
}

const PY_STMT_BLOCK = new Set(['block']);
const TS_STMT_BLOCK = new Set(['statement_block']);
const CONTROL = /\b(return|raise|break|continue|yield|await|throw|del|global|nonlocal)\b/;

function stmtNames(
  s: SyntaxNode,
  grammar: GrammarId,
): { writes: Set<string>; all: Set<string>; calls: boolean } {
  const writes = new Set<string>();
  const all = new Set<string>();
  let calls = false;
  walk(s, (n) => {
    if (n.type === 'identifier') all.add(n.text);
    if (n.type === 'call' || n.type === 'call_expression' || n.type === 'new_expression') calls = true;
    const left =
      n.type === 'assignment' ||
      n.type === 'augmented_assignment' ||
      n.type === 'assignment_expression' ||
      n.type === 'augmented_assignment_expression'
        ? n.childForFieldName('left')
        : n.type === 'variable_declarator'
          ? n.childForFieldName('name')
          : null;
    if (left)
      walk(left, (m) => {
        if (m.type === 'identifier') writes.add(m.text);
        return true;
      });
    if (grammar === 'python' && n.type === 'for_statement') {
      const l = n.childForFieldName('left');
      if (l)
        walk(l, (m) => {
          if (m.type === 'identifier') writes.add(m.text);
          return true;
        });
    }
    return true;
  });
  return { writes, all, calls };
}

function independent(a: SyntaxNode, b: SyntaxNode, grammar: GrammarId): boolean {
  if (CONTROL.test(a.text) || CONTROL.test(b.text)) return false;
  const na = stmtNames(a, grammar);
  const nb = stmtNames(b, grammar);
  if (na.calls && nb.calls) return false;
  for (const w of na.writes) if (nb.all.has(w)) return false;
  for (const w of nb.writes) if (na.all.has(w)) return false;
  return true;
}

function reorderStatements(c: Ctx): OpResult {
  if (!c.fn) return null;
  const blocks = c.grammar === 'python' ? PY_STMT_BLOCK : TS_STMT_BLOCK;
  const pairs: Array<[SyntaxNode, SyntaxNode]> = [];
  walk(c.fn, (n) => {
    if (!blocks.has(n.type)) return true;
    const stmts = childrenOf(n).filter((s) => !['{', '}', 'comment'].includes(s.type));
    for (let i = 0; i + 1 < stmts.length; i++) {
      const a = stmts[i] as SyntaxNode;
      const b = stmts[i + 1] as SyntaxNode;
      if (a.startPosition.row === b.startPosition.row) continue;
      if (a.startPosition.column !== b.startPosition.column) continue;
      if (
        i === 0 &&
        c.grammar === 'python' &&
        a.type === 'expression_statement' &&
        a.child(0)?.type === 'string'
      )
        continue; // docstring
      if (independent(a, b, c.grammar)) pairs.push([a, b]);
    }
    return true;
  });
  const pair = pickOne(c.rng, pairs);
  if (!pair) return null;
  const [a, b] = pair;
  const text = applyEdits(c.text, [
    { start: a.startIndex, end: a.endIndex, text: b.text },
    { start: b.startIndex, end: b.endIndex, text: a.text },
  ]);
  return {
    writes: [{ path: c.path, text }],
    note: `swapped lines ${a.startPosition.row + 1} and ${b.startPosition.row + 1}`,
  };
}

const PY_EXPR = new Set(['binary_operator', 'comparison_operator', 'boolean_operator', 'call']);
const TS_EXPR = new Set(['binary_expression', 'call_expression']);
const NO_EXTRACT = /\b(yield|await|lambda|super|this|arguments)\b|=>|\bfor\b/;

function extractHelper(c: Ctx): OpResult {
  const fn = c.fn;
  if (!fn) return null;
  const kinds = c.grammar === 'python' ? PY_EXPR : TS_EXPR;
  const candidates: SyntaxNode[] = [];
  const body = bodyOf(fn);
  if (!body) return null;
  walk(body, (n, p) => {
    if (!kinds.has(n.type) || !p) return true;
    const ok =
      same(p.childForFieldName('right'), n) ||
      same(p.childForFieldName('value'), n) ||
      same(p.childForFieldName('condition'), n) ||
      p.type === 'return_statement' ||
      p.type === 'argument_list' ||
      p.type === 'arguments' ||
      p.type === 'parenthesized_expression';
    if (!ok) return true;
    if (p.type === 'decorator') return true;
    if (NO_EXTRACT.test(n.text) || n.text.includes('\n')) return true;
    if (n.endIndex - n.startIndex < 5) return true;
    candidates.push(n);
    return true;
  });
  const e = pickOne(c.rng, candidates);
  if (!e) return null;
  const params: string[] = [];
  for (const id of variableIdents(e, c.grammar)) {
    // the callee of a call stays a free (global) name
    if (!params.includes(id.text)) params.push(id.text);
  }
  const name =
    c.grammar === 'python' ? `_helper_${Math.floor(c.rng() * 1e6)}` : `helper${Math.floor(c.rng() * 1e6)}`;
  const call = `${name}(${params.join(', ')})`;
  // insert the helper before the top-level statement that contains the function
  const top = childrenOf(c.root).find((s) => s.startIndex <= fn.startIndex && s.endIndex >= fn.endIndex);
  if (!top) return null;
  const helper =
    c.grammar === 'python'
      ? `def ${name}(${params.join(', ')}):\n    return (${e.text})\n\n\n`
      : `function ${name}(${params.join(', ')}) {\n  return (${e.text});\n}\n\n`;
  const text = applyEdits(c.text, [
    { start: top.startIndex, end: top.startIndex, text: helper },
    { start: e.startIndex, end: e.endIndex, text: call },
  ]);
  return { writes: [{ path: c.path, text }], note: `extracted ${JSON.stringify(e.text)} into ${name}` };
}

function indentOfRow(text: string, idx: number): string {
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(lineStart));
  return m ? m[0] : '';
}

function invertCondition(c: Ctx): OpResult {
  if (!c.fn) return null;
  const ifs: SyntaxNode[] = [];
  walk(c.fn, (n) => {
    if (n.type === 'if_statement') ifs.push(n);
    return true;
  });
  const usable = ifs.filter((n) => {
    const cons = n.childForFieldName('consequence');
    if (!cons) return false;
    if (c.grammar === 'python') {
      if (childrenOf(n).some((k) => k.type === 'elif_clause')) return false;
      if (cons.startPosition.row === n.startPosition.row) return false;
    } else {
      const alt = n.childForFieldName('alternative');
      if (alt && childrenOf(alt).some((k) => k.type === 'if_statement')) return false;
    }
    return true;
  });
  const node = pickOne(c.rng, usable);
  if (!node) return null;
  const cond = node.childForFieldName('condition') as SyntaxNode;
  const cons = node.childForFieldName('consequence') as SyntaxNode;
  const alt = node.childForFieldName('alternative');
  const edits: Edit[] = [];
  if (c.grammar === 'python') {
    edits.push({ start: cond.startIndex, end: cond.endIndex, text: `not (${cond.text})` });
    const elseBody = alt?.childForFieldName('body');
    if (alt && elseBody) {
      edits.push({ start: cons.startIndex, end: cons.endIndex, text: elseBody.text });
      edits.push({ start: elseBody.startIndex, end: elseBody.endIndex, text: cons.text });
    } else {
      const ifIndent = indentOfRow(c.text, node.startIndex);
      const bodyIndent = indentOfRow(c.text, cons.startIndex);
      edits.push({
        start: cons.startIndex,
        end: cons.startIndex,
        text: `pass\n${ifIndent}else:\n${bodyIndent}`,
      });
    }
  } else {
    // condition is a parenthesized_expression: `(x)` → `(!(x))`
    const inner = cond.text.startsWith('(') && cond.text.endsWith(')') ? cond.text.slice(1, -1) : cond.text;
    edits.push({ start: cond.startIndex, end: cond.endIndex, text: `(!(${inner}))` });
    const altStmt = alt ? childrenOf(alt).find((k) => k.type !== 'else') : null;
    if (alt && altStmt) {
      edits.push({ start: cons.startIndex, end: cons.endIndex, text: altStmt.text });
      edits.push({ start: altStmt.startIndex, end: altStmt.endIndex, text: cons.text });
    } else {
      edits.push({ start: cons.startIndex, end: cons.startIndex, text: '{} else ' });
    }
  }
  return {
    writes: [{ path: c.path, text: applyEdits(c.text, edits) }],
    note: `inverted the if on line ${node.startPosition.row + 1}`,
  };
}

function moveToFile(c: Ctx): OpResult {
  if (!c.fn) return null;
  const span = unitSpans(c.root, c.grammar).find((s) => s.qualname === c.qualname);
  if (!span) return null;
  const isMethod = c.qualname.includes('.');
  const nameNode = c.fn.childForFieldName('name');
  if (!nameNode) return null;
  const name = nameNode.text;
  const rename = c.rng() < 0.5;
  const newName = rename ? `${name}_impl` : name;
  const slash = c.path.lastIndexOf('/');
  const dir = slash >= 0 ? c.path.slice(0, slash + 1) : '';
  const file = c.path.slice(slash + 1);
  const dot = file.indexOf('.');
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  const ext = dot >= 0 ? file.slice(dot) : '';
  const newStem = c.grammar === 'python' ? `${stem}_moved` : `${stem}.moved`;
  const newPath = `${dir}${newStem}${ext}`;
  if (c.allPaths.has(newPath)) return null;
  // whole lines of the unit span
  const lineStart = c.text.lastIndexOf('\n', span.start - 1) + 1;
  const nl = c.text.indexOf('\n', span.end);
  const lineEnd = nl === -1 ? c.text.length : nl + 1;
  const indent = indentOfRow(c.text, span.start);
  let moved: string;
  let replacement: string;
  let importLine: string;
  if (c.grammar === 'python') {
    const src = c.text.slice(lineStart, lineEnd);
    const dedented = src
      .split('\n')
      .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
      .join('\n');
    moved = rename ? dedented.replace(`def ${name}(`, `def ${newName}(`) : dedented;
    replacement = isMethod ? `${indent}${name} = ${newName}\n` : '';
    importLine =
      isMethod || rename
        ? `from .${newStem} import ${newName}${!isMethod && rename ? ` as ${name}` : ''}\n`
        : `from .${newStem} import ${name}\n`;
  } else {
    if (c.fn.type === 'method_definition') {
      if (childrenOf(c.fn).some((k) => ['get', 'set', 'static', 'async', '*'].includes(k.type))) return null;
      const params = c.fn.childForFieldName('parameters');
      const body = c.fn.childForFieldName('body');
      if (!params || !body) return null;
      const inner = params.text.slice(1, -1).trim();
      moved = `export function ${newName}(this: any${inner ? `, ${inner}` : ''}) ${body.text}\n`;
      replacement = `${indent}${name} = ${newName};\n`;
      importLine = `import { ${newName} } from './${newStem}';\n`;
    } else if (c.fn.type === 'function_declaration') {
      const src = c.text.slice(span.start, span.end).replace(/^export\s+/, '');
      const nameRel =
        nameNode.startIndex - span.start - (c.text.slice(span.start, span.end).length - src.length);
      moved = `export ${src.slice(0, nameRel)}${newName}${src.slice(nameRel + name.length)}\n`;
      replacement = '';
      importLine = `import { ${newName}${rename ? ` as ${name}` : ''} } from './${newStem}';\n`;
    } else return null;
  }
  // the moved code keeps the source file's imports, so it still resolves its names
  const imports = childrenOf(c.root)
    .filter((s) => ['import_statement', 'import_from_statement', 'future_import_statement'].includes(s.type))
    .map((s) => s.text);
  if (imports.length) moved = `${imports.join('\n')}\n\n\n${moved}`;
  const edits: Edit[] = [{ start: lineStart, end: lineEnd, text: replacement }];
  edits.push({ start: importOffset(c), end: importOffset(c), text: importLine });
  return {
    writes: [
      { path: c.path, text: applyEdits(c.text, edits) },
      { path: newPath, text: moved },
    ],
    note: `moved ${c.qualname} to ${newPath}${rename ? ` as ${newName}` : ''}`,
  };
}

/** Offset after the leading docstring/imports, where a new import line goes. */
function importOffset(c: Ctx): number {
  let off = 0;
  for (const s of childrenOf(c.root)) {
    const isImport =
      s.type === 'import_statement' ||
      s.type === 'import_from_statement' ||
      s.type === 'future_import_statement' ||
      (c.grammar === 'python' &&
        s.type === 'expression_statement' &&
        s.child(0)?.type === 'string' &&
        off === 0);
    if (!isImport) break;
    const nl = c.text.indexOf('\n', s.endIndex);
    off = nl === -1 ? c.text.length : nl + 1;
  }
  return off;
}

const OPS: Record<Exclude<MutationFamily, 'split-across-sessions'>, (c: Ctx) => OpResult> = {
  'rename-locals': renameLocals,
  'reorder-statements': reorderStatements,
  'extract-helper': extractHelper,
  'invert-condition': invertCondition,
  'move-to-file': moveToFile,
};

// ------------------------------------------------------------------ split-across-sessions

/** Hunks of a line diff as `{oldStart, oldEnd, newLines}` (0-based line indices into `before`). */
function hunks(before: string, after: string): Array<{ oldStart: number; oldEnd: number; lines: string[] }> {
  const b = before.split('\n');
  const a = after.split('\n');
  const ch = changedLines(before, after);
  const oldSet = new Set(ch.old.map((x) => x - 1));
  const newSet = new Set(ch.new.map((x) => x - 1));
  // walk both sides in lock-step over unchanged lines
  const out: Array<{ oldStart: number; oldEnd: number; lines: string[] }> = [];
  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (!oldSet.has(i) && !newSet.has(j)) {
      i++;
      j++;
      continue;
    }
    const start = i;
    const lines: string[] = [];
    while (i < b.length && oldSet.has(i)) i++;
    while (j < a.length && newSet.has(j)) lines.push(a[j++] as string);
    out.push({ oldStart: start, oldEnd: i, lines });
  }
  return out;
}

function applyHunks(
  before: string,
  hs: ReadonlyArray<{ oldStart: number; oldEnd: number; lines: string[] }>,
): string {
  const b = before.split('\n');
  for (const h of [...hs].sort((x, y) => y.oldStart - x.oldStart))
    b.splice(h.oldStart, h.oldEnd - h.oldStart, ...h.lines);
  return b.join('\n');
}

function splitAcrossSessions(input: MutateInput, rng: () => number): Mutant | null {
  const files = input.files.filter((f) => f.baseline !== undefined && (f.baseline ?? '') !== f.text);
  if (files.length === 0) return null;
  const all = files.flatMap((f) => hunks(f.baseline ?? '', f.text).map((h) => ({ f, h })));
  if (all.length < 2) return null;
  for (let attempt = 0; attempt < 32; attempt++) {
    const order = shuffle(rng, all);
    const k = 1 + Math.floor(rng() * (order.length - 1));
    const first = new Set(order.slice(0, k));
    const s1: FileWrite[] = [];
    let ok = true;
    for (const f of files) {
      const hs = all.filter((x) => x.f === f && first.has(x)).map((x) => x.h);
      if (hs.length === 0) continue;
      const text = applyHunks(f.baseline ?? '', hs);
      if (!parses(input.provider, f.path, text)) {
        ok = false;
        break;
      }
      s1.push({ path: f.path, text });
    }
    if (!ok || s1.length === 0) continue;
    const s2: FileWrite[] = files.map((f) => ({ path: f.path, text: f.text }));
    return {
      family: 'split-across-sessions',
      seed: input.seed,
      sessions: [s1, s2],
      target: null,
      note: `session 1 applies ${k} of ${order.length} hunks; session 2 completes the re-application`,
    };
  }
  return null;
}

// ------------------------------------------------------------------ entry points

/** Produce one mutant, or null when the operator does not apply to any target unit. */
export function mutate(input: MutateInput): Mutant | null {
  const rng = keyedRng(`${input.family}:${input.seed}:${input.revertSha}`);
  if (input.family === 'split-across-sessions') return splitAcrossSessions(input, rng);
  const op = OPS[input.family];
  const allPaths = new Set(input.files.map((f) => f.path));
  const targets = shuffle(
    rng,
    input.units.filter((u) => u.qualname !== MODULE_UNIT && !u.qualname.endsWith('.<body>')),
  );
  for (const t of targets) {
    const f = input.files.find((x) => x.path === t.file);
    const g = f && grammarForPath(f.path);
    if (!f || !g) continue;
    const tree = input.provider.parse(g, f.text);
    try {
      const fn = unitFunction(tree.rootNode, g, t.qualname);
      const res = op({
        provider: input.provider,
        rng,
        path: f.path,
        text: f.text,
        grammar: g,
        root: tree.rootNode,
        qualname: t.qualname,
        fn,
        allPaths,
      });
      if (!res) continue;
      const valid = res.writes.every((w) => w.text === null || parses(input.provider, w.path, w.text));
      const changed = res.writes.some(
        (w) => w.text !== (input.files.find((x) => x.path === w.path)?.text ?? null),
      );
      if (!valid || !changed) continue;
      return { family: input.family, seed: input.seed, sessions: [res.writes], target: t, note: res.note };
    } finally {
      tree.delete?.();
    }
  }
  return null;
}

/** The family's five mutants (one per seed); seeds whose operator does not apply are skipped. */
export function mutants(input: Omit<MutateInput, 'seed'>, split: 'tune' | 'held-out' = 'held-out'): Mutant[] {
  const out: Mutant[] = [];
  for (const seed of seedsFor(input.family, split)) {
    const m = mutate({ ...input, seed });
    if (m) out.push(m);
  }
  return out;
}
