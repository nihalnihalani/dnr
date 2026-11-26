import { type ParseArgsConfig, parseArgs } from 'node:util';
import { usage } from './errors';

export type Opts = NonNullable<ParseArgsConfig['options']>;
export type Values = Record<string, string | boolean | string[] | boolean[] | undefined>;

/** Strict flag parsing; unknown flags and missing values are usage errors (exit 64). */
export function parse(argv: string[], options: Opts): { values: Values; positionals: string[] } {
  try {
    const r = parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: r.values as Values, positionals: r.positionals };
  } catch (e) {
    throw usage(String((e as Error).message));
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
