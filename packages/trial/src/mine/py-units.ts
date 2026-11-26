/**
 * Fallback Python unit resolver (indentation-based), used only until the engine's §5.2
 * qualnames are available. Candidates record `units_source: 'fallback-indent'`.
 */
const DEF_RE = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** qualname for each 1-based line; '<module>' for module-level lines. */
export function pyLineQualnames(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [''];
  const stack: Array<{ indent: number; name: string }> = [];
  let bracket = 0;
  let inTriple: string | null = null;
  for (const line of lines) {
    const stripped = line.trim();
    const indent = line.length - line.trimStart().length;
    const continuation = bracket > 0 || inTriple !== null;
    if (!continuation && stripped.length > 0 && !stripped.startsWith('#')) {
      while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent)
        stack.pop();
      const m = DEF_RE.exec(line);
      if (m) stack.push({ indent, name: m[2] as string });
    }
    out.push(stack.length > 0 ? stack.map((s) => s.name).join('.') : '<module>');
    // Track open brackets and triple-quoted strings so continuation lines do not pop the stack.
    let i = 0;
    while (i < line.length) {
      if (inTriple) {
        const end = line.indexOf(inTriple, i);
        if (end < 0) break;
        i = end + 3;
        inTriple = null;
        continue;
      }
      const ch = line[i] as string;
      if (ch === '#') break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        inTriple = line.slice(i, i + 3);
        i += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = line.indexOf(ch, i + 1);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if ('([{'.includes(ch)) bracket++;
      else if (')]}'.includes(ch)) bracket = Math.max(0, bracket - 1);
      i++;
    }
  }
  return out;
}

export function pyQualnameSet(text: string): Set<string> {
  return new Set(pyLineQualnames(text).slice(1));
}
