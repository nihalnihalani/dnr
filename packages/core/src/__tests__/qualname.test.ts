import { beforeAll, describe, expect, it } from 'vitest';
import type { ParserProvider } from '../syntax';
import { extractUnits, qualnames } from '../units';
import { grammars } from './helpers';

let P: ParserProvider;
beforeAll(async () => {
  P = await grammars();
});

const PY = `import os

X = 1

@decorator
@other(arg=1)
def top(a, b):
    def closure(c):
        return c + a
    class Local:
        def inner(self):
            return 2
    return closure(b)

class Outer:
    attr = 3

    class Inner:
        def m(self):
            return 1

    @property
    def value(self):
        return self._v

    @value.setter
    def value(self, v):
        self._v = v

    def value(self):
        return 0

def top(x):
    return x

if os.environ:
    def conditional():
        pass
`;

describe('python qualnames (§5.2)', () => {
  it('extracts every scorable unit', () => {
    const u = extractUnits(P, 'm.py', PY);
    expect(u && [...u.units.keys()]).toEqual([
      '<module>',
      'top',
      'Outer.<body>',
      'Outer.Inner.<body>',
      'Outer.Inner.m',
      'Outer.value',
      'Outer.value#2',
      'Outer.value#3',
      'top#2',
      'conditional',
    ]);
  });

  const lineOf = (needle: string) => PY.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const at = (needle: string) => qualnames(P, 'm.py', PY, [[lineOf(needle), lineOf(needle)]]);

  it('maps decorators to the unit they decorate', () => {
    expect(at('@decorator')).toEqual(['top']);
    expect(at('@other(arg=1)')).toEqual(['top']);
    expect(at('@value.setter')).toEqual(['Outer.value#2']);
    expect(at('@property')).toEqual(['Outer.value']);
  });
  it('maps nested closures and local classes to the enclosing unit', () => {
    expect(at('return c + a')).toEqual(['top']);
    expect(at('return 2')).toEqual(['top']);
  });
  it('maps methods of nested classes and class bodies', () => {
    expect(at('return 1')).toEqual(['Outer.Inner.m']);
    expect(at('attr = 3')).toEqual(['Outer.<body>']);
    expect(at('class Inner:')).toEqual(['Outer.Inner.<body>']);
  });
  it('numbers repeated names with #2, #3', () => {
    expect(at('return x')).toEqual(['top#2']);
    expect(at('return 0')).toEqual(['Outer.value#3']);
  });
  it('maps top-level statements to <module>', () => {
    expect(at('import os')).toEqual(['<module>']);
    expect(at('X = 1')).toEqual(['<module>']);
  });
  it('assigns each token to the smallest unit only', () => {
    const u = extractUnits(P, 'm.py', PY);
    const body = u?.units.get('Outer.<body>')?.tokens ?? [];
    expect(body).toEqual(['class', 'Outer', ':', 'attr', '=', '3']);
    const mod = u?.units.get('<module>')?.tokens ?? [];
    expect(mod.slice(0, 5)).toEqual(['import', 'os', 'X', '=', '1']);
    expect(mod).toContain('if');
    expect(mod).not.toContain('def');
    expect(u?.units.get('top')?.tokens.slice(0, 4)).toEqual(['@', 'decorator', '@', 'other']);
  });
});

const TS = `import { a } from './a';

function over(a: string): string;
function over(a: number): number;
function over(a: any): any {
  const inner = () => a;
  return inner();
}

export const arrow = (x: number) => x + 1;
let fnExpr = function () { return 1; };

export default class Foo {
  field = 1;
  handler = () => this.field;
  @dec
  m(): void {}
  get v() { return 1; }
  set v(x: number) {}
  ov(): void;
  ov(a?: number): void {}
}

namespace Ns {
  export function g() { return 2; }
}

class Bar { m() { return 3; } }
`;

describe('typescript qualnames (§5.15)', () => {
  it('extracts every scorable unit', () => {
    const u = extractUnits(P, 'm.ts', TS);
    expect(u && [...u.units.keys()]).toEqual([
      '<module>',
      'over',
      'arrow',
      'fnExpr',
      'Foo.<body>',
      'Foo.handler',
      'Foo.m',
      'Foo.v',
      'Foo.v#2',
      'Foo.ov',
      'Ns.g',
      'Bar.<body>',
      'Bar.m',
    ]);
  });
  const lineOf = (needle: string) => TS.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const at = (needle: string) => qualnames(P, 'm.ts', TS, [[lineOf(needle), lineOf(needle)]]);
  it('joins overload signatures to their implementation', () => {
    expect(at('function over(a: string)')).toEqual(['over']);
    expect(at('ov(): void;')).toEqual(['Foo.ov']);
  });
  it('maps decorators, closures, fields and namespaces', () => {
    expect(at('@dec')).toEqual(['Foo.m']);
    expect(at('const inner')).toEqual(['over']);
    expect(at('field = 1')).toEqual(['Foo.<body>']);
    expect(at('return 2')).toEqual(['Ns.g']);
    expect(at('import { a }')).toEqual(['<module>']);
  });
  it('names anonymous default exports <default>', () => {
    const u = extractUnits(
      P,
      'd.ts'.replace('d.ts', 'dflt.ts'),
      'export default function () { return 1; }\nexport class K { m() {} }\n',
    );
    expect(u && [...u.units.keys()]).toEqual(['<module>', '<default>', 'K.<body>', 'K.m']);
  });
  it('does not score .d.ts files', () => {
    expect(extractUnits(P, 'types.d.ts', 'declare function f(): void;')).toBeNull();
  });
});
