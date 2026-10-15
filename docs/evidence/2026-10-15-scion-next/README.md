# Scion continuation evidence

All workloads in this directory use local PostgreSQL, filesystem-backed source storage and the existing local Linux VM. External provider calls: zero. No full private import was repeated. Local fixtures and operation IDs use fresh isolated schemas.

Commands use the repository's pinned Node 24.21.0 and pnpm 11.25.0.

| Command | Stored result |
|---|---|
| `node --import tsx --test tests/blame-scaling.test.ts` | `blame-scaling-red.txt`: original 306 statements, native origins equal, 160-statement ceiling fails |
| Same command, after request-context reuse | `blame-reader-probe.txt`: 259 statements |
| Same command, after commit metadata reuse | `blame-commit-reuse-probe.txt`: 180 statements, still fails |
| `node --import tsx --test tests/blame-scaling.test.ts tests/blame-native.test.ts tests/blame-budget.test.ts tests/derived-indexes.test.ts` | `blame-scaling-green.txt`: 150 statements, first ceiling passes |
| `node --import tsx --test tests/blame-scaling.test.ts` | `blame-batch-red.txt`: stricter 100-statement ceiling fails before batched graph implementation |
| `node --import tsx --test tests/blame-scaling.test.ts tests/blame-native.test.ts tests/derived-indexes.test.ts` | `blame-batch-green.txt`: 79 statements, eight passing tests |
| `node --import tsx --test --test-concurrency=4 tests/*.test.ts` | `full-e2e.txt`: 85 passing tests |
| `pnpm typecheck` | `typecheck.txt` |
| `pnpm build` | `build.txt`: Worker dry-run bundle |
| `pnpm exec wrangler deploy` | `deploy.txt`: successful production deployment `ba605dad-e0af-419d-afda-be13e901303f` |
| `node --import tsx tests/virtual-workspace.e2e.ts` | `virtual-workspace-red.txt`: missing implementation; `virtual-lifecycle-red.txt`: background-child cleanup failure; `virtual-workspace-green.txt` and `virtual-workspace-result.json`: final real Linux result |

The eight-client production benchmark and full private import remain in the previous evidence directory. They have not been rerun or relabeled as measurements of this checkpoint. The original failing reports are retained, including implementation and harness failures.

Production deployment is separate from the local workloads. `production-smoke.json` records two bounded CLI probes (401 and 403), neither an authenticated performance measurement. No automatic retry, provider cache purge, quota increase or new recurring job was made.

The subsequent signed-in production browser check returned HTTP 200 for the private README blame and matched all 75 retained line identities. `production-blame-verification.json` records that comparison. It reuses the existing v4 cache and does not measure a fresh cold computation.
