/**
 * §9.12 ast-grep baseline rule generator (entry point: `scripts/baseline/gen.ts`; both files are hashed). One rule file per order: one pattern per statement C
 * added in each covered unit, combined with `any`, with metavariables in place of local
 * identifiers (parameters, assignment and loop targets) and `language` set per file. Rules are
 * generated, never hand-edited; this file and its output are hashed before `prereg-v1`.
 *
 * Used by `dnr trial baseline --generate` and `scripts/baseline/gen.ts`.
 */
import { changedLines, extractUnits, grammarForPath, type ParserProvider, type SyntaxNode } from '@dnr/core';
import type { Order } from '@dnr/schemas';

export const GEN_VERSION = 1;

const COMPOUND =
  /^(if|for|while|with|try|match|function_definition|class_definition|decorated_definition|async_.*)_?statement$|^(function_definition|class_definition|decorated_definition)$/;
const SIMPLE = /_statement$|^expression_statement$/;

function children(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c) out.push(c);
  }
  return out;
}

function* walk(n: SyntaxNode): Generator<SyntaxNode> {
  yield n;
  for (const c of children(n)) yield* walk(c);
}

/** Local identifiers of the unit: parameters, assignment / augmented-assignment / for targets (not `self`, `cls`). */
export function localNames(unitRoot: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const addTargets = (n: SyntaxNode | null) => {
    if (!n) return;
    if (n.type === 'identifier') out.add(n.text);
    else if (/pattern_list|tuple_pattern|list_pattern|tuple|list|parenthesized/.test(n.type))
      children(n).forEach(addTargets);
  };
  for (const n of walk(unitRoot)) {
    if (n.type === 'parameters' || n.type === 'lambda_parameters')
      for (const p of walk(n)) if (p.type === 'identifier') out.add(p.text);
    if (n.type === 'assignment' || n.type === 'augmented_assignment') addTargets(n.childForFieldName('left'));
    if (n.type === 'for_statement' || n.type === 'for_in_clause') addTargets(n.childForFieldName('left'));
  }
  out.delete('self');
  out.delete('cls');
  return out;
}

/** The statement's text with local identifiers replaced by `$L0`, `$L1`, … (consistent per rule), dedented. */
export function patternOf(
  stmt: SyntaxNode,
  locals: ReadonlySet<string>,
  names: Map<string, string>,
  indent?: number,
): string {
  const ids = [...walk(stmt)].filter((n) => n.type === 'identifier' && locals.has(n.text));
  let text = '';
  let at = stmt.startIndex;
  const src = stmt.text;
  for (const id of ids.sort((a, b) => a.startIndex - b.startIndex)) {
    text += src.slice(at - stmt.startIndex, id.startIndex - stmt.startIndex);
    let mv = names.get(id.text);
    if (!mv) {
      mv = `$L${names.size}`;
      names.set(id.text, mv);
    }
    text += mv;
    at = id.endIndex;
  }
  text += src.slice(at - stmt.startIndex);
  // Continuation lines are dedented by the indentation of the line the node starts on.
  const col = indent ?? stmt.startPosition.column;
  return text
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.startsWith(' '.repeat(col)) ? l.slice(col) : l.trimStart()))
    .join('\n');
}

const touches = (n: SyntaxNode, added: ReadonlySet<number>) => {
  for (let l = n.startPosition.row + 1; l <= n.endPosition.row + 1; l++) if (added.has(l)) return true;
  return false;
};

/** Statements of C inside the unit that C added: simple statements starting on an added line, or compound statements wholly added. */
export function addedStatements(
  root: SyntaxNode,
  start: number,
  end: number,
  added: ReadonlySet<number>,
): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode) => {
    const s = n.startPosition.row + 1;
    const e = n.endPosition.row + 1;
    if (e < start || s > end) return;
    if (COMPOUND.test(n.type) && s >= start && e <= end) {
      let all = true;
      for (let l = s; l <= e; l++) if (!added.has(l)) all = false;
      if (all && !/function_definition|class_definition|decorated_definition/.test(n.type)) {
        out.push(n);
        return;
      }
      // A changed header (`if <cond>:`, `while <cond>:`, `elif`): the header's expression is the pattern.
      const cond = n.childForFieldName('condition');
      if (cond && touches(cond, added)) out.push(cond);
    } else if (n.type === 'elif_clause') {
      const cond = n.childForFieldName('condition');
      if (cond && touches(cond, added)) out.push(cond);
    } else if (SIMPLE.test(n.type) && !COMPOUND.test(n.type) && s >= start && e <= end && added.has(s)) {
      out.push(n);
      return;
    }
    children(n).forEach(visit);
  };
  visit(root);
  return out;
}

export interface RuleFile {
  order_id: string;
  /** YAML text (JSON-quoted scalars), one document per file language; null when the order only removes code. */
  yaml: string | null;
  patterns: number;
  na_removal_only: boolean;
}

const q = (s: string) => JSON.stringify(s);

/**
 * Rule file for one order. `textAt(sha, file)` reads history. Removal-only orders get no rule
 * (reported `na_removal_only`, not counted as misses).
 */
export async function generateRule(
  provider: ParserProvider,
  order: Order,
  textAt: (sha: string, file: string) => Promise<string | null>,
): Promise<RuleFile> {
  const byLang = new Map<string, string[]>();
  for (const u of order.units) {
    if (u.kind === 'removed') continue;
    const grammar = grammarForPath(u.file);
    if (!grammar) continue;
    const C = u.c_state_ref.sha;
    const after = await textAt(C, u.file);
    const before = await textAt(`${C}^`, u.file);
    if (after === null) continue;
    const added = new Set<number>(changedLines(before ?? '', after).new);
    const fu = extractUnits(provider, u.file, after);
    const unit = fu?.units.get(u.c_state_ref.qualname);
    if (!unit) continue;
    const root = provider.parse(grammar, after).rootNode;
    // The unit's own node: the smallest node spanning its lines, used for local names.
    let unitNode: SyntaxNode = root;
    for (const n of walk(root))
      if (
        n.startPosition.row + 1 === unit.startLine &&
        n.endPosition.row + 1 === unit.endLine &&
        n.type !== 'module'
      ) {
        unitNode = n;
        break;
      }
    const locals = unit.qualname === '<module>' ? new Set<string>() : localNames(unitNode);
    const names = new Map<string, string>();
    const lang = grammar === 'tsx' ? 'tsx' : grammar === 'typescript' ? 'typescript' : 'python';
    const pats = byLang.get(lang) ?? [];
    for (const s of addedStatements(root, unit.startLine, unit.endLine, added)) {
      const line = after.split('\n')[s.startPosition.row] ?? '';
      const p = patternOf(s, locals, names, line.length - line.trimStart().length);
      if (p.trim() && !pats.includes(p)) pats.push(p);
    }
    byLang.set(lang, pats);
  }
  const docs: string[] = [];
  let n = 0;
  for (const [lang, pats] of [...byLang.entries()].sort()) {
    if (pats.length === 0) continue;
    n += pats.length;
    docs.push(
      [
        `id: ${order.id}-${lang}`,
        `language: ${lang}`,
        `message: ${q(`re-applies the change reverted by ${order.revert_sha ?? order.original_sha}`)}`,
        'severity: warning',
        'rule:',
        '  any:',
        ...pats.map((p) => `    - pattern: ${q(p)}`),
      ].join('\n'),
    );
  }
  return {
    order_id: order.id,
    yaml: docs.length
      ? `# generated by scripts/baseline/gen.ts (baseline-gen v${GEN_VERSION}); do not edit\n${docs.join('\n---\n')}\n`
      : null,
    patterns: n,
    na_removal_only: docs.length === 0,
  };
}
