import { beforeAll, describe, expect, it } from 'vitest';
import { diffTokens } from '../diff';
import type { ParserProvider } from '../syntax';
import { tokenize } from '../tokenize';
import { TYPE_ARG_CLOSE, TYPE_ARG_OPEN, weightOf } from '../weights';
import { grammars } from './helpers';

let P: ParserProvider;
beforeAll(async () => {
  P = await grammars();
});
const keys = (g: 'python' | 'typescript' | 'tsx', t: string) => tokenize(P, g, t).map((x) => x.key);

describe('python tokens (§5.1)', () => {
  it('drops comments, keeps each string literal whole, keeps identifiers as written', () => {
    expect(keys('python', 'x = f"a{y}b" + \'s\'  # note\nreturn Foo_bar\n')).toEqual([
      'x',
      '=',
      'f"a{y}b"',
      '+',
      "'s'",
      'return',
      'Foo_bar',
    ]);
  });
  it('weights punctuation 0 and keywords/operators 1', () => {
    const k = keys('python', 'def f(a, *b) -> None:\n    return a ** 2 if a else (b := 1)\n');
    expect(
      weightOf(['.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '=', '->', ':=', '@', '\\'], 'python'),
    ).toBe(0);
    expect(weightOf(['**', '*', 'self', 'None', 'return', 'if'], 'python')).toBe(6);
    expect(k).toContain('->');
    expect(k).toContain(':=');
  });
  it('maps a line continuation to the weight-0 token \\', () => {
    const k = keys('python', 'x = 1 + \\\n    2\n');
    expect(k).toEqual(['x', '=', '1', '+', '\\', '2']);
    expect(weightOf(k, 'python')).toBe(4);
  });
  it('is unaffected by whitespace and comments', () => {
    expect(keys('python', 'def f(a,b):\n  return a+b\n')).toEqual(
      keys('python', '# c\ndef f( a, b ):   # x\n\n      return a + b\n'),
    );
  });
  it('handles non-ASCII text with correct offsets', () => {
    expect(keys('python', 'naïve = "héllo ☃"\nx = naïve\n')).toEqual([
      'naïve',
      '=',
      '"héllo ☃"',
      'x',
      '=',
      'naïve',
    ]);
  });
});

describe('typescript tokens (§5.15)', () => {
  it('a.b → a?.b yields a non-empty A/R', () => {
    const d = diffTokens(keys('typescript', 'a.b;'), keys('typescript', 'a?.b;'));
    expect(d.A.length + d.R.length).toBeGreaterThan(0);
    expect(weightOf(d.A, 'typescript') + weightOf(d.R, 'typescript')).toBeGreaterThan(0);
    expect(d.A).toContain('?.');
  });
  it('keeps meaning-changing operators at weight 1', () => {
    expect(weightOf(['**', '??', '?.', '...', '||', '*'], 'typescript')).toBe(6);
    expect(
      weightOf(['.', ',', ':', ';', '(', ')', '[', ']', '{', '}', '=', '=>', '@', '`'], 'typescript'),
    ).toBe(0);
  });
  it('weights < and > 0 only in type arguments', () => {
    const k = keys('typescript', 'let m: Map<string, number> = f<T>(a < b, c > d);');
    expect(k.filter((x) => x === TYPE_ARG_OPEN)).toHaveLength(2);
    expect(k.filter((x) => x === TYPE_ARG_CLOSE)).toHaveLength(2);
    expect(k).toContain('<');
    expect(k).toContain('>');
    expect(weightOf(['<', '>'], 'typescript')).toBe(2);
  });
  it('treats template literals per §5.15', () => {
    expect(keys('typescript', 'x = `plain text`;')).toEqual(['x', '=', '`plain text`', ';']);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the TS source under test contains a template literal
    expect(keys('typescript', 'x = `a ${b + 1} c\\n${d}`;')).toEqual([
      'x',
      '=',
      '`',
      'a ',
      '${',
      'b',
      '+',
      '1',
      '}',
      ' c\\n',
      '${',
      'd',
      '}',
      '`',
      ';',
    ]);
  });
  it('keeps strings and regexes whole and drops comments', () => {
    expect(keys('tsx', 'const r = /a+b/g; // c\nconst s = "x y"; /* d */ <div>{s}</div>;')).toEqual([
      'const',
      'r',
      '=',
      '/a+b/g',
      ';',
      'const',
      's',
      '=',
      '"x y"',
      ';',
      '<',
      'div',
      '>',
      '{',
      's',
      '}',
      '</',
      'div',
      '>',
      ';',
    ]);
  });
});
