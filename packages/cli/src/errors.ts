/** CLI exit codes (§8): 0 clean, 1 findings, 64 usage, 65 invalid data, 69 dependency missing, 70 internal. */
export const EXIT = { OK: 0, FINDINGS: 1, USAGE: 64, DATA: 65, DEPENDENCY: 69, INTERNAL: 70 } as const;

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export const usage = (m: string) => new CliError(m, EXIT.USAGE);
export const invalidData = (m: string) => new CliError(m, EXIT.DATA);
export const missingDependency = (m: string) => new CliError(m, EXIT.DEPENDENCY);
