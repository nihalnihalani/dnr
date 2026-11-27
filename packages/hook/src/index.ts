/**
 * @dnr/hook: Kiro hook entry points (§5.4–5.14, §6). Every `run*` entry point fails open.
 */
export {
  checkHuman,
  type GuardResult,
  humanGuard,
  isAgentHost,
  KIRO_AGENT_VARS,
  type Proc,
  processChain,
} from './ancestry';
export {
  type CrossingFinding,
  checkCommit,
  checkFile,
  checkStaged,
  checkWorktree,
  crossingCheck,
  stagedOrderWeakening,
} from './commit';
export {
  baseDecision,
  type HookContext,
  type HookIO,
  type HookOptions,
  makeEvent,
  openContext,
  sessionPatch,
} from './context';
export {
  contributingQualnames,
  type Derived,
  decideWrite,
  deriveStatus,
  type EffectiveStatus,
  effectiveStatus,
  filesOf,
  loadParser,
} from './engine';
export { type HookEvent, parseHookEvent, StdinError, shellCommandOf } from './event';
export { failOpen } from './failopen';
export { approvalOrigin, grantOrigin, launchMarkers, testHarness } from './grant-origin';
export {
  bundleSha256,
  fileSha256,
  type InstallRecord,
  installGlobs,
  installMismatch,
  installRoot,
  nodePaths,
} from './install';
export {
  blockText,
  cap,
  MAX_REASON_CHARS,
  ordersChangedReason,
  protectMessage,
  stopReason,
  warnMessage,
} from './messages';
export { orderSetAt, weakenedBetween } from './order-history';
export { loadEntries } from './orders';
export { postShellCheck, postShellReason } from './post-shell';
export {
  decideConfig,
  gitHooksDirs,
  isProtectedPath,
  protectRoots,
  renderDecision,
  runPreWrite,
} from './prewrite';
export { canonicalDecision, formatReplay, type ReplayLine, replayEvents, sortedJson } from './replay';
export { BlobReader, readWorktree, realpathLoose, repoRelative } from './repo';
export {
  runSessionConfirm,
  runSessionStart,
  runShellAfter,
  sessionEnd,
  sessionGc,
  sessionShow,
} from './session-hooks';
export {
  evaluateShell,
  r6Subcommand,
  runGuardShell,
  type ShellEnv,
  type ShellFinding,
  type ShellRule,
  shellMessage,
} from './shell';
export { isDnr, parseCommands, type SimpleCommand } from './shell-parse';
export { runStop, scoreTouched, tamperFindings } from './stop';
export {
  coverageOf,
  loadTrusted,
  openTamper,
  parseConfigText,
  readTamper,
  type TamperFlag,
  type TrustedState,
} from './trusted';
export { DNR_VERSION } from './version';
export { clearViolation, readViolations, recordViolation, type Violation } from './violations';
