import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './diff';

const SAMPLE = `diff --git a/x.py b/x.py
index 111..222 100644
--- a/x.py
+++ b/x.py
@@ -3 +3,2 @@ def f():
-    return 1
+    y = 2
+    return y
@@ -10,0 +12 @@ class A:
+    z = 3
\\ No newline at end of file
diff --git a/new.py b/new.py
new file mode 100644
index 000..333
--- /dev/null
+++ b/new.py
@@ -0,0 +1 @@
+print(1)
diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;

describe('parseUnifiedDiff', () => {
  const files = parseUnifiedDiff(SAMPLE);
  it('parses files and statuses', () => {
    expect(files.map((f) => [f.oldPath, f.newPath, f.status, f.binary])).toEqual([
      ['x.py', 'x.py', 'modified', false],
      [null, 'new.py', 'added', false],
      ['old.py', null, 'deleted', false],
      ['img.png', 'img.png', 'modified', true],
    ]);
  });
  it('parses -U0 hunks with implicit counts and context', () => {
    const [h1, h2] = files[0]?.hunks ?? [];
    expect(h1).toEqual({
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 2,
      context: 'def f():',
      removed: ['    return 1'],
      added: ['    y = 2', '    return y'],
    });
    expect(h2).toMatchObject({
      oldStart: 10,
      oldLines: 0,
      newStart: 12,
      newLines: 1,
      added: ['    z = 3'],
      removed: [],
    });
  });
  it('parses deletions', () => {
    expect(files[2]?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      removed: ['a', 'b'],
    });
  });
});
