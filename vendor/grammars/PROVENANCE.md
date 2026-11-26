# Vendored tree-sitter grammars

These `.wasm` files are copied byte-for-byte from the npm packages pinned in
`packages/grammar/package.json`. Each package ships a prebuilt `.wasm` in its
published tarball, so the plan's fallback (build in `emscripten/emsdk`) was not needed.
`scripts/check-grammar.mjs` loads each grammar with web-tree-sitter 0.27.2 and parses a sample.

| File | Source package | Version | Path in package | ABI | License | sha256 |
|---|---|---|---|---|---|---|
| `tree-sitter-python.wasm` | `tree-sitter-python` (npm) | 0.25.0 | `tree-sitter-python.wasm` | 15 | MIT | `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47` |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript` (npm) | 0.23.2 | `tree-sitter-typescript.wasm` | 14 | MIT | `778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d` |
| `tree-sitter-tsx.wasm` | `tree-sitter-typescript` (npm) | 0.23.2 | `tree-sitter-tsx.wasm` | 14 | MIT | `79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8` |

The runtime itself is not vendored. It comes from the pinned `web-tree-sitter@0.27.2`
package (`web-tree-sitter.wasm`, sha256 `488beeff7adb7fd7e21e97cc29a43dc6d031977755eda892d6d96c7f456cfdec`).

To verify: `shasum -a 256 vendor/grammars/*.wasm`, then `node scripts/check-grammar.mjs`.
