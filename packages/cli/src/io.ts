/** The CLI's injectable I/O: tests pass fakes; bin.ts passes the real process. */
import type { GuardResult } from '@dnr/hook';

/** Run the dnr-drafter agent with `prompt`; return its raw text output. */
export type DraftRunner = (input: { agentPath: string; prompt: string; cwd: string }) => Promise<string>;

export type BoardStarter = (
  opts: Record<string, unknown>,
) => Promise<{ port: number; origin: string; launchUrl: string; close(): Promise<void> }>;

export interface CliIO {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin(): Promise<string>;
  out(s: string): void;
  err(s: string): void;
  /** The R6 human-only guard (process ancestry, TTY, Kiro variables). */
  guard(): GuardResult;
  /** Ask the human a question at the TTY (absent: not interactive, the answer is no). */
  prompt?: (question: string) => Promise<string>;
  /** Whether stdin/stdout are a TTY, for grant provenance (tests inject it). */
  isTTY?: () => boolean;
  /** Process ancestry for grant provenance (tests inject it; default: `ps`). */
  processChain?: () => import('@dnr/hook').Proc[];
  /** The path of the running CLI script (init refuses npx cache paths). */
  scriptPath: string;
  draftRunner?: DraftRunner;
  boardStarter?: BoardStarter;
  openBrowser?: (url: string) => void;
  /** Resolves when the board should shut down (default: SIGINT/SIGTERM). */
  untilExit?: () => Promise<void>;
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
