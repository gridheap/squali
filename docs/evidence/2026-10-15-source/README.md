# Source-service acceptance evidence

**Status: private production verification, final provider reconciliation and the current continuous video are pending. No final percentage or submitted entry is claimed.**

The fixed release requirements are in [the Scion checklist](../../scion-acceptance.md). The previous progress notes and failure history are preserved in [chronology](chronology.md); individual reports remain unchanged.

## Current executable checks

| Check | Exact command | Retained result |
|---|---|---|
| Complete HTTP/CLI/native suite | `pnpm test:e2e` | [73/73 passed](mainline-graph-full-e2e.txt) |
| Types | `pnpm typecheck` | [Passed](mainline-graph-typecheck.txt) |
| Worker build | `pnpm build` | [Dry run passed](mainline-graph-build.txt) |
| Deployment | `pnpm deploy` | [Worker 4a36bd39-edf7-4689-9b67-84bc7646f4f4](mainline-graph-deploy.txt) |
| Rendered UI and typography | `SQUALI_URL=http://127.0.0.1:8799 WEAVE_UI_EVIDENCE=docs/evidence/2026-10-15-source/final-copy-ui pnpm test:ui` | [Four passed](final-copy-ui.txt); [screens and glyph evidence](final-copy-ui/) |
| Actual Linux FUSE | See the exact command in the retained JSON | [First content reads](fuse-green-attempt.json), [shared-cache run](fuse-green.json) |

The suite uses real PostgreSQL, HTTP entry points, native Git and a persistent filesystem adapter at the R2 boundary. Four test processes share local resources; concurrency tests still run eight clients. UI checks include failure fallback, navigation reuse, Proxima Nova Latin and platform PingFang SC CJK. Historical cold Adobe timeout evidence remains retained.

## Architecture and performance evidence

| Subject | Evidence | What it establishes |
|---|---|---|
| Canonical authority | [Source tests in the full report](mainline-graph-full-e2e.txt) | Rebuild identical native trees/commits after removing compatibility metadata; preserve historic modes and non-UTF-8 commit bytes |
| Unified derived data | [Generic index checks](derived-full-e2e.txt), [recursive blame](derived-blame-full-e2e.txt) | Versioned parent dependencies, eager/lazy rebuilding, explicit resource bounds |
| Mainline graph queries | [Original merge-base failure](mainline-merge-base-red.txt), [merge-heavy ancestry failure](mainline-ancestry-red.txt), [native comparison passed](mainline-ancestry-green.txt) | 1,024-commit mainline queries use 13 SQL statements; criss-cross and second-parent behavior remains correct |
| Prepared PostgreSQL protocol | [Before](database-protocol-red.txt), [after](database-protocol-green.txt) | Real HTTP workflows reuse prepared statements and decode array fields correctly |
| Immutable object cache | [Cache acceptance](immutable-source-cache-green.txt), [production read sample](production-immutable-cache.json) | Repeated source-row queries fall from 11 to zero; authentication and scope remain live; failures do not bypass cache tiers |
| Incremental proposal/publication cost | [Proposal admission](proposal-admission-green.txt), [publication](publication-cost-green.txt) | Independent proposal admission, bounded SQL, no new blob I/O for the independent selected publication fixture |
| Native file monitor | [Watcher](working-copy-watch-green.txt), [base-change race](working-copy-watch-race-red.txt), [full suite](mainline-graph-full-e2e.txt) | Real filesystem observation, finite budgets, final reconciliation and no implicit tracking |
| Local throughput | [Source sample](local-source.json) | 64 changes/eight clients, 318.19 changes/s, p95 95.93 ms; local only |
| Production throughput | [Baseline](cloud-baseline.json), [reference-only](cloud-optimized.json), [single connection](cloud-connection.json), [pool adjustment](cloud-pool8.json), [prepared protocol](cloud-prepared.json) | Retains all bounded samples and unfavorable results; latest eight-change p95 is 3,368.85 ms |
| Provider diagnosis | [Connection metrics](hyperdrive-performance.json), [direct pool contention](hyperdrive-pool-contention.json) | Connection-establishment latency is distinct from pool waiting; concurrent import limits causal conclusions |

[Performance notes](../../performance.md) explain sample sizes and operating limits. The two-second proposal investigation target remains unmet. No claim of Anthropic-scale throughput, a 99% fleet cache hit rate or a universal speedup is made.

## Production private import

The frozen fixture contains 421,219 objects, 85,563 commits, 1,020 refs and 8,332,097,572 raw bytes. Its native Git pack is 324,579,659 bytes. It reuses one retained Git input and journal. The [23:31 UTC checkpoint](private-progress-2331.json) has 398,592 admitted object positions and remains incomplete.

The final verifier is `python3 scripts/verify-import.py PROJECT RETAINED_NATIVE_REPOSITORY --state PRIVATE_STATE --file README.md`. It uses at most 40 API attempts and one retained verification clone, compares every exported object/ref, runs native fsck, and independently checks source inventory, graph, root tree, selected history/blame and up to eight canonical deltas. Completed replay makes no network transfer. [Timing acceptance](verification-timing-journal.txt) also verifies retained per-attempt measurements and unchanged replay: API, history/blame, ancestry, merge-base, clone and fsck times come from this same run. [Its local real-entry-point test](verify-canonical-green.txt) also detects a corrupted canonical delta before a clone.

The production Clerk/GitHub login and repository catalog have [retained browser evidence](production-github-login.png). The completed private workspace still needs its final browser check.

## Cost and release gates

- [Admission budget](../../source-import-budget.md): deduplicated inputs, finite attempts, current official prices and separate Azure/Workers/storage exposure.
- [R2 provider checkpoint](provider-r2-checkpoint.json): provider observations with reporting lag; it is not an invoice or the final reconciliation.
- [Public Azure list prices](azure-retail-prices.json): existing infrastructure still has a cost. Private billing records stay outside the public repository.
- [Continuous recording instructions](../../demo-source.md): final capture refuses to run without the completed private report. Earlier quick format/preflight probes are not a submission video.
- [Entry form text](../../entry-fields.md): prepared for the eligible entrant after all gates pass.
