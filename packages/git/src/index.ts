export { listTree, readBlob } from './blob';
export { commitDiffU0, diffU0, type FileDiff, filePath, type Hunk, parseUnifiedDiff } from './diff';
export {
  classifyMessage,
  classifyRevertKind,
  type DiscoveredRevert,
  type DiscoverOptions,
  discoverReverts,
  extractQuotedSubject,
  isLineSubsetUndo,
  type LoggedCommit,
  logGrepRevert,
  type MatchedForm,
  type MatchMethod,
  type MessageClass,
  parseLogRecords,
  type RevertKind,
  type RevertTag,
  SUBJECT_RE,
} from './discovery';
export { GitError, type GitOptions, type GitResult, git, runGit } from './exec';
export { inversePatchId, type PatchIdIndex, patchId, patchIdIndex } from './patchid';
export { changedPaths, isAncestor, mergeBase, parents, resolveCommit, revParse, treeOf } from './refs';
export { type RevertReproduction, reproduceRevert, revertReproduces } from './revert-check';
export { DEFAULT_LANG_EXTS, defaultBranch, matchesLang, type ScanPair, scanPairs } from './scan';
export {
  catBlobs,
  commitInfo,
  committedStateArgs,
  findRepoRoot,
  githubBase,
  gitPath,
  headCommit,
  memoGit,
  revList,
  snapshotTree,
  stagedPaths,
  treeDiffNames,
  tryResolve,
} from './worktree';
