# imara-diff attribution and modifications

`src/imara-line-diff.ts` is a TypeScript adaptation of the Apache-2.0 licensed
[imara-diff](https://github.com/pascalkuthe/imara-diff), by Pascal Kuthe and contributors.
Pinned upstream revision: `f02e46a737c43c0d9c65a42e5e08046bd10fd739` (version 0.2.0).
The upstream `Cargo.toml` declares `license = "Apache-2.0"`; its full license
is reproduced in [Apache-2.0.txt](Apache-2.0.txt).

Adapted upstream modules: `myers.rs`, `myers/middle_snake.rs`,
`myers/preprocess.rs`, `myers/slice.rs`, `postprocess.rs`,
`slider_heuristic.rs`, and hunk helpers in `util.rs`/`lib.rs`.

Modifications Copyright (c) 2026 Grid Heap, also under Apache-2.0:

- TypeScript numeric tokens, typed arrays and explicit traversal stack replace
  Rust pointers, slices and recursion. The public MIT wrapper preserves newline
  identity and admits at most 2,000 lines on either side.
- Every search, classification and hunk traversal charges the caller's shared
  work budget. Metadata queries stop at four million comparison units.
- Count frequencies before trimming common edges; round the power-of-two
  square-root estimate upward. Process removals before additions.
- Correct trailing-blank counts at EOF, apply the EOF penalty only at EOF,
  avoid unsigned start-position underflow, and recognize vertical whitespace.
- Count the candidate separator in both neighboring pruning contexts so short
  edits do not discard a shared blank line; a minimized native regression
  reproduces the real README history failure before this correction.
- Omit histogram, word diff and formatted output: only the bounded line-hunk
  interface is used. Native Git differential tests are the compatibility oracle.

This replaces the earlier in-tree LGPL adaptation; it is not a
relabeling of that source. The replacement was built from the pinned Apache
implementation, with a Rust probe first establishing the 134-case oracle result.
Historical acceptance logs remain records of the implementation then tested.

Rebuild and verify: `pnpm typecheck`, `pnpm test:e2e`, `pnpm build`.
No Rust or WASM toolchain is required by the shipped project.
