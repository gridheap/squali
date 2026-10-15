# Performance and cost evidence

Squali's source store uses R2 blobs and PostgreSQL changesets/indexes. The latest production proposal sample has **p50 1,486.23 ms, p95 3,368.85 ms and 2.301 changes/second**. Publishing its eight changes takes **1,824.66 ms**. The two-second proposal investigation target remains unmet. These bounded samples do not establish a universal performance ranking or Anthropic's reported scale.

## Production observations

| Sample | Changes / clients | Proposal throughput | Proposal p95 | Publication |
|---|---:|---:|---:|---:|
| Initial source baseline | 64 / 8 | 2.094/s | 5317.45 ms | 26954.73 ms |
| Reuse blob identities during publication | 8 / 8 | 1.832/s | 4296.56 ms | 2251.08 ms |
| One connection per Worker request | 8 / 8 | 1.350/s | 5820.88 ms | 1890.81 ms |
| Eight-origin-connection configuration | 8 / 8 | 2.104/s | 3731.29 ms | 2142.17 ms |
| Prepared protocol and current derivation | 8 / 8 | 2.301/s | 3368.85 ms | 1824.66 ms |

All samples use the same workspace, originally containing 64 files and 419,400 bytes. Requests originate on the existing Azure eastus2 VM while the private import is running. Eight clients share one agent principal. Each follow-up writes eight new blobs; it does not repeat the successful 64-change baseline. **Different batch sizes and concurrent import conditions prevent a controlled speedup comparison.**

The baseline retains 152 HTTP attempts across two segments, including nine initial authorization failures. Every follow-up uses 25 attempts without a retry. Reports and exact commands: [baseline](evidence/2026-10-15-source/cloud-baseline.json), [blob reuse](evidence/2026-10-15-source/cloud-optimized.json), [one connection](evidence/2026-10-15-source/cloud-connection.json), [pool configuration](evidence/2026-10-15-source/cloud-pool8.json), [prepared protocol](evidence/2026-10-15-source/cloud-prepared.json). The [bounded runner](source-operations.md) retains its journal and makes no network calls on completed replay.

The latest sample ran against Worker `40919ac2-91fe-490d-9843-6465a853843a`, after commit `6e73423`. Artifacts reservations stayed at 172. Its explicit file verification added one source read; shared source-write counters also contain import traffic and cannot be attributed to this sample. Later deployment `4a36bd39-edf7-4689-9b67-84bc7646f4f4` adds the mainline graph shortcuts described below, without changing the proposal path. The current deployment `7c16dd9b-d8bc-4d36-a133-967938277a0f` also adds the bounded R2 Git snapshot fallback. No further cloud load sample is scheduled.

## Changes supported by local measurements

| Operation | Measured result | Evidence |
|---|---|---|
| Four-file / 64-file proposals | 33 / 32 SQL statements | [Admission E2E](evidence/2026-10-15-source/proposal-admission-green.txt) |
| Seal 128 imported commits | 17 SQL statements, from an initial 1,793 | [Current full suite](evidence/2026-10-15-source/mainline-graph-full-e2e.txt) |
| Mainline merge-base, either argument order | 13 SQL statements, from 1,026 | [Initial failure](evidence/2026-10-15-source/mainline-merge-base-red.txt), [native comparison](evidence/2026-10-15-source/mainline-ancestry-green.txt) |
| Positive ancestry through a merge-heavy mainline | 13 SQL statements, from 387 | [Initial failure](evidence/2026-10-15-source/mainline-ancestry-red.txt), [native comparison](evidence/2026-10-15-source/mainline-ancestry-green.txt) |
| Repeated immutable object read | Source-row queries fall from 11 to zero | [Cache E2E](evidence/2026-10-15-source/immutable-source-cache-green.txt) |
| Preview/publication of 64 independent changes | No additional source-blob reads or writes | [Publication E2E](evidence/2026-10-15-source/publication-cost-green.txt) |

The writer passes its known delta to the shared versioned derivation engine. Independent admission uses one atomic insert, while dependency admission retains its transaction. Graph shortcuts return only after proving a first-parent relationship; other cases keep all-parent traversal and native criss-cross comparisons. The graph fixture contains a 1,024-commit mainline with 128 merge commits. Cache authorization, revocation and workspace-state checks remain live.

The [local 64-change/eight-client source sample](evidence/2026-10-15-source/local-source.json) reaches 318.19 changes/s and p95 95.93 ms. It uses local PostgreSQL and the filesystem storage adapter, so it is not cloud throughput. The complete API/CLI/native suite has [78 passing tests](evidence/2026-10-15-source/source-snapshot-final-suite.txt); the later [import write verifier](evidence/2026-10-15-source/private-write-verification-green.txt) has its own focused E2E.

## Database and cache interpretation

Postgres.js uses prepared statements, following [Cloudflare's guidance](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/). Array type discovery remains enabled for `text[]`. Each Worker request uses at most one database connection. Hyperdrive's configured origin limit is eight; the dedicated PostgreSQL role is capped at twelve to leave native-runner headroom. No VM/database SKU was enlarged.

Cloudflare's `connectionLatency` measures connection establishment, not pool waiting. [Direct contention metrics](evidence/2026-10-15-source/hyperdrive-pool-contention.json) show peak waiting clients of three before and two after the pool adjustment, and a maximum pool size of one per reported pool record. This does not mean every Worker has eight simultaneous connections. PostgreSQL CPU peaked at 59.5% and memory at 71.8% in the adjustment window. Different traffic windows limit causal attribution.

Real Linux FUSE runs use two mounts and one shared node daemon: 2.275 seconds with two content reads, then 1.284 seconds with zero new content reads. Directory metadata reads no file bodies. Stopping the daemon makes reads fail without bypassing it. These observations do not establish a 99% fleet hit rate.

Production file reads in the original sample take 541–729 ms first and 288–399 ms repeated. Existing upstream caches were not cleared. A separate [immutable-cache check](evidence/2026-10-15-source/production-immutable-cache.json) retains its own conditions and results. Neither is an empty-every-tier cold benchmark.

## Import and ongoing costs

The private fixture has 421,219 objects, 85,563 commits, 1,020 refs, 8.33 GB of raw data and a 324.6 MB Git pack. Its source import needs 166,297 unique blob writes. It retains one input and cumulative journal, with 12,000 HTTP attempts, 200,000 monthly source-write reservations and one active native job. Six source-upload slots refill as requests finish, respecting [Workers' pending-connection limit](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections).

Independent private verification and final provider reconciliation remain release gates. [The admission budget](source-import-budget.md) records official prices, the retry-bounded maximum, shared allowance uncertainty, Azure capacity and continuing storage exposure. Provider analytics, application reservations and an invoice are different measurements. Earlier failed attempts remain included in the evidence.

## Historical native Git comparison

This preserved comparison predates the independent source store and measures the legacy adapter. It must not be presented as the current cloud result.

Command: `pnpm exec tsx scripts/compare-git.ts`. [Full report](evidence/2026-10-14-scion/native-comparison/comparison.json).

Both paths start with 64 files (419,400 bytes), then 32 independent one-file changes using eight clients. Native Git reuses eight full clones and proposal branches, followed by one ancestry-preserving octopus merge. Squali includes authentication, SQL journals, review and metering. Both final trees equal `d3c9183b8919adab49d3e680f7daeb6f7f809279`, contain 96 files, retain 32 proposal refs and pass native fsck.

| Measured phase | Squali | Native Git |
|---|---:|---:|
| Proposals/second | 63.74 | 40.99 |
| Proposal p50 | 115.72 ms | 189.80 ms |
| Proposal p95 | 145.04 ms | 203.08 ms |
| Proposal maximum / sample p99 | 146.36 ms | 203.72 ms |
| Publication | 333.05 ms | 1438.95 ms |

Native clone preparation takes 360.55 ms; Squali review takes 51.87 ms. Both are reported separately from proposal timing. This is one local Apple M4 Max sample with 128 GiB RAM and no cloud calls. Bare Git does not provide the same workflow services. The result does not measure distributed contention, provider cost or CPU/memory consumption. Its initial gzip-negotiation failure and subsequent fix remain retained.
