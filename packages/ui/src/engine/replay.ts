/** Smallest unique str_replace that turns `a` into `b` (line granularity). */
export function strReplaceFor(a: string, b: string): { old_str: string; new_str: string } | null {
  if (a === b) return null;
  const A = a.split('\n');
  const B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf])
    suf++;
  let lo = pre;
  let hiA = A.length - suf;
  let hiB = B.length - suf;
  for (;;) {
    const old_str = A.slice(lo, hiA).join('\n');
    const count = old_str ? a.split(old_str).length - 1 : 0;
    if (old_str && count === 1) return { old_str, new_str: B.slice(lo, hiB).join('\n') };
    if (lo === 0 && hiA === A.length) return { old_str: a, new_str: b };
    if (lo > 0) lo--;
    if (hiA < A.length) {
      hiA++;
      hiB++;
    }
  }
}
