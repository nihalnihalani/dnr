/**
 * @dnr/core — the isomorphic DNR match engine (plan §5). No `node:*` imports.
 * See packages/core/README.md for the API overview.
 */
export { applyTool, type ToolEffect } from './apply-tool';
export {
  type BuildOrderFile,
  type BuildOrderInput,
  type BuildOrderResult,
  buildOrder,
  changedLines,
  extractUnitChanges,
  materialFromTexts,
  orderId,
  type UnitChange,
  unitHash,
} from './build-order';
export { DEFAULT_MATCH_CONFIG, type MatchConfig, matchConfig } from './config';
export {
  blockMessage,
  DEFAULT_DECIDE_CONFIG,
  type DecideConfig,
  type DecideEffects,
  type DecideInput,
  type DecideResult,
  decide,
  type OrderBreakdown,
  type OrderEntry,
  reasonLine,
} from './decide';
export { diffTokens, sameTokens, type TokenDiff } from './diff';
export { type Relocation, relocateUnit } from './fingerprint';
export { DEFAULT_TEST_GLOBS, globToRegExp, isTestPath, matchesGlob } from './glob';
export {
  fingerprintsOf,
  type OrderMaterial,
  type UnitFingerprint,
  type UnitMaterial,
  unitKey,
} from './material';
export { intersectionWeight, jaccard, type Multiset, multiset, shingles3 } from './multiset';
export { isProtected, normalizePath, type ProtectRoots, protectedGlobs } from './protect';
export { BODY_UNIT, DEFAULT_UNIT, MODULE_UNIT, type UnitSpan, unitSpans } from './qualname';
export {
  isCrossing,
  matchState,
  type OrderScore,
  type ProposedSource,
  proxUnit,
  type ScoreOptions,
  scoreOrder,
  type UnitScore,
} from './score';
export { sha256Hex } from './sha256';
export {
  isRelanded,
  isStale,
  relandedScore,
  type StaleOptions,
  type StaleReport,
  staleReport,
} from './stale';
export { createState, overlayState, type StateView, type TextSource, UnitCache } from './state';
export {
  childrenOf,
  type GrammarId,
  grammarForPath,
  type ParserProvider,
  type SyntaxNode,
  type SyntaxPoint,
  type SyntaxTree,
} from './syntax';
export { lineStarts, rowAt, type Token, tokenize, tokenizeTree } from './tokenize';
export {
  DEGRADED_ERROR_SHARE,
  extractUnits,
  type FileUnits,
  qualnameAtLine,
  qualnames,
  qualnamesForLines,
  type Unit,
  unitsFromTree,
} from './units';
export {
  NORMALIZER_VERSION,
  TYPE_ARG_CLOSE,
  TYPE_ARG_OPEN,
  tokenWeight,
  weightOf,
  weightSet,
} from './weights';
