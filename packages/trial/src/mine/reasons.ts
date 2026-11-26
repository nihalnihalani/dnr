import type { ReasonCategory } from '@dnr/schemas';

export interface ReasonInput {
  /** R's subject. */
  subject: string;
  /** R's body. */
  body: string;
  /** The quoted original subject inside R's subject, removed before keyword rules. */
  quotedSubject: string | null;
  /** Files C changed. */
  cFiles: string[];
}

export interface ReasonProposal {
  category: ReasonCategory;
  rule: string;
}

const isDoc = (p: string) =>
  p.startsWith('docs/') || /\.(txt|rst)$/.test(p) || /^(README|AUTHORS|CONTRIBUTING)/.test(p);
const isTest = (p: string) => p.startsWith('tests/') || p.startsWith('js_tests/');
const isCi = (p: string) =>
  p.startsWith('.github/') ||
  p.startsWith('scripts/') ||
  p.startsWith('extras/') ||
  /^(tox\.ini|setup\.cfg|setup\.py|pyproject\.toml|MANIFEST\.in|package\.json|Gruntfile\.js|eslint\.config\.mjs|\.eslintrc.*|\.pre-commit-config\.yaml|\.readthedocs\.yml|\.editorconfig|\.gitignore|\.gitattributes|\.flake8|\.isort\.cfg)$/.test(
    p,
  ) ||
  p.startsWith('tests/requirements/');
const isFrontend = (p: string) => /\.(js|mjs|css|scss|html|svg|png|gif)$/.test(p);

/** Keyword rules, in priority order. Applied to R's message with C's quoted subject removed. */
const KEYWORD_RULES: ReadonlyArray<{ id: string; re: RegExp; category: ReasonCategory }> = [
  {
    id: 'kw:accidental',
    re: /\b(accidental(ly)?|by mistake|unintentional(ly)?|wrong branch|prematurely|committed too early)\b/i,
    category: 'ACCIDENTAL_COMMIT',
  },
  {
    id: 'kw:release-timing',
    re: /\b(feature freeze|too late|postpone[ds]?|defer(red)? to|not ready for (the )?release|release blocker)\b/i,
    category: 'RELEASE_TIMING',
  },
  {
    id: 'kw:performance',
    re: /\b(performance|slow(er|down|s)?|memory (usage|leak)|perf regression)\b/i,
    category: 'PERFORMANCE_REGRESSION',
  },
  {
    id: 'kw:crash',
    re: /\b(crash(es|ed)?|exception|traceback|segfault|segmentation fault|\w+Error)\b/,
    category: 'CRASH',
  },
  {
    id: 'kw:backward-incompat',
    re: /\b(backwards?[- ]incompatib\w*|backwards?[- ]compat\w*|broke (third[- ]party|existing|user)|compatibility)\b/i,
    category: 'BACKWARD_INCOMPAT',
  },
  { id: 'kw:deprecation', re: /\bdeprecat\w*|\bundeprecat\w*/i, category: 'API_POLICY_REVERSAL' },
  {
    id: 'kw:regression',
    re: /\b(regression|flawed|incorrect(ly)?|wrong|broke|broken|bug|caused|unexpected)\b/i,
    category: 'CORRECTNESS_REGRESSION',
  },
  {
    id: 'kw:superseded',
    re: /\b(superseded|duplicate[sd]?|in favor of|replaced by)\b/i,
    category: 'DUPLICATE_SUPERSEDED',
  },
];

/**
 * Rule-engine reason proposal (§9.1 step 4). Labelers never see this; it only seeds the
 * candidates file. File-scope rules come first, then keyword rules on R's own words.
 */
export function proposeReason(input: ReasonInput): ReasonProposal {
  const files = input.cFiles;
  if (files.length > 0) {
    if (files.every(isDoc)) return { category: 'DOCS_ONLY', rule: 'files:docs-only' };
    if (files.every((p) => isTest(p) || isDoc(p))) return { category: 'TEST_ONLY', rule: 'files:tests-only' };
    if (files.every((p) => isCi(p) || isDoc(p))) return { category: 'CI_INFRA', rule: 'files:ci-only' };
    if (files.every((p) => isFrontend(p) || isDoc(p) || isTest(p)))
      return { category: 'FRONTEND_ONLY', rule: 'files:frontend-only' };
  }
  let subject = input.subject;
  if (input.quotedSubject) subject = subject.replace(`"${input.quotedSubject}"`, '');
  const body = input.body
    .split('\n')
    .filter((l) => !/^This reverts commit /i.test(l) && !/^Backport of /i.test(l))
    .join('\n');
  const text = `${subject}\n${body}`;
  for (const r of KEYWORD_RULES) if (r.re.test(text)) return { category: r.category, rule: r.id };
  return { category: 'OTHER', rule: 'default:other' };
}
