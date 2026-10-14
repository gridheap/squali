# Performance and cost evidence

## Current source architecture

Source blobs live in R2; changesets and indexes live in PostgreSQL. The measurements below use that architecture. They are bounded samples, not evidence of Anthropic's reported traffic or a universal performance ranking.

| Sample | Proposal throughput | Proposal p95 | Publication |
|---|---:|---:|---:|
| Local, 64 changes / 8 clients | 318.19 changes/s | 95.93 ms | See retained local report |
| Production, 64 changes / 8 clients, before reference-only publication | 2.094 changes/s | 5317.45 ms | 26954.73 ms |
| Production reference-only follow-up, 8 changes / 8 clients | 1.832 changes/s | 4296.56 ms | 2251.08 ms |
| Production one-connection-per-request follow-up, 8 changes / 8 clients | 1.350 changes/s | 5820.88 ms | 1890.81 ms |

All start from 64 baseline files totaling 419,400 bytes. Production requests originate on the existing Azure eastus2 VM and share the deployment with the large private import. The baseline retained 152 HTTP attempts across two segments, including nine initial authorization failures; the follow-up retained 25 HTTP attempts. Eight clients share one agent principal. The eight-change follow-up reuses the baseline and writes eight new blobs. **Different batch sizes cannot establish a publication speedup ratio.**

Commands and results: [local source](evidence/2026-10-15-source/local-source.json), [production baseline](evidence/2026-10-15-source/cloud-baseline.json), [follow-up](evidence/2026-10-15-source/cloud-optimized.json), and the [bounded runner instructions](source-operations.md). Completed journal replay does no network work. No successful full cloud benchmark was repeated. The latest [connection follow-up](evidence/2026-10-15-source/cloud-connection.json) adds eight unique blobs in the same workspace, uses 25 requests and has no retry. Its proposal p95 is worse; this remains an open latency investigation, not a demonstrated improvement. Provider metrics show connection waiting during the sample while PostgreSQL CPU stays below 22% and memory below 71%. The windows include concurrent import traffic.

The baseline exposed sequential blob reads during publication. Publication now reuses verified blob identities and only loads content when conflict resolution or a semantic policy requires it. A retained 64-change E2E proves zero extra source-blob reads or writes during preview/publication. The production follow-up consumed one source read for its explicit verification; Artifacts reservations stayed at 172. Global source write counters also include concurrent import traffic and cannot be attributed to this sample alone.

Batch sealing 128 commits fell from 1,793 SQL queries to 18 in the retained local fixture. Hyperdrive metrics showed connection waiting during concurrent proposals while PostgreSQL CPU peaked at 28.69% and IOPS at 36 of its 120 provisioned limit. The latest deployment uses one database connection per Worker request and a lazy request-local project lookup. Its single-connection concurrent E2E passes; the final row above measures that connection change. A five-connection shared Hyperdrive origin pool still queues the concurrent workload; tuning that bounded pool is being evaluated.

Online proposals now carry their known file delta into source sealing. A four-file proposal fell from 46 to 35 SQL queries, and a 64-file proposal fell from 97 to 34 after batching its path-index insert. Re-sealing the same commit through the independent import path produces the identical canonical changeset ID, including deletions and executable modes. These are local query counts, not a cloud latency ratio. See `proposal-cost-red.txt`, `proposal-paths-red.txt` and `proposal-full-e2e.txt` in the source evidence directory.

## Cache and cost boundaries

Actual Linux FUSE evidence uses two mounts through one shared node daemon: the first run took 2.275 seconds and fetched two content objects; the repeated run took 1.284 seconds with zero new objects. Directory metadata fetched no file bodies. Stopping the daemon made reads fail without direct origin bypass. These results do not establish a 99% fleet cache hit rate.

Production file reads in the 64-change sample took 541–729 ms first, then 288–399 ms repeated. Existing upstream caches were not cleared, so these are first/repeat observations, not an empty-every-layer cold benchmark. See [source evidence](evidence/2026-10-15-source/README.md).

The large private source import admits 166,297 unique blob writes, with a persistent total limit of 200,000 monthly source writes and 12,000 import HTTP attempts. Successful objects survive resumes. [The admission budget](source-import-budget.md) records official R2 pricing, expected and bounded costs, shared allowance uncertainty and separate Azure/Workers/Artifacts costs. [Provider R2 metrics](evidence/2026-10-15-source/provider-r2-checkpoint.json) are a lagging checkpoint, not a final invoice. Final import and provider reconciliation remain acceptance gates.

## Earlier Git-adapter comparison

The following preserved comparison predates the independent source store. It measures the legacy Git adapter and must not be presented as the current source-store cloud result.

Command: `pnpm exec tsx scripts/compare-git.ts`. Full report: [JSON](evidence/2026-10-14-scion/native-comparison/comparison.json).

Both paths start with 64 files (419,400 bytes), then 32 independent one-file changes with eight clients. PostgreSQL has five connections. Native Git uses eight reusable full clones and retained proposal branches, then one ancestry-preserving octopus merge. Squali uses its normal authenticated API, journal, review and metering. Both final trees equal `d3c9183b8919adab49d3e680f7daeb6f7f809279`, contain 96 verified files, retain 32 proposal refs, and pass native `git fsck`.

| Measured phase | Squali | Native Git |
|---|---:|---:|
| Proposals/second | 63.74 | 40.99 |
| Proposal p50 | 115.72 ms | 189.80 ms |
| Proposal p95 | 145.04 ms | 203.08 ms |
| Proposal maximum / sample p99 | 146.36 ms | 203.72 ms |
| Batch publication | 333.05 ms | 1438.95 ms |

Native clone preparation took 360.55 ms, excluded from proposal timing. Squali review took 51.87 ms, also reported separately. Its publication pack was 3143 bytes for 32 changes. No cloud provider calls occurred.

This is one bounded local sample on an Apple M4 Max with 128 GiB RAM. With 32 observations, p99 is effectively the maximum. Bare Git does not provide Squali's identity, review or journal services. Results do not measure distributed workloads, contention, CPU/memory consumption, network egress or cloud cost per workflow. They cannot establish universal “highest performance” or “best value”.

The first comparison exposed dropped gzip negotiation on larger clones. The gateway now bounds compressed and expanded negotiation to 1 MiB. The retained failure and success reports document that fix.

Source upload now refills six request slots as they finish, instead of waiting for each eight-object wave. The E2E deliberately blocks the first object and proves later objects proceed with at most six operations outstanding, one PUT per unique object and no PUT on replay. This matches [Workers’ pending-connection limit](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections). It changes scheduling, not the admitted object count.

The unified versioned index engine adds explicit path-completion markers and input-size checks. Current retained SQL counts are 40 for a four-file proposal, 39 for a 64-file proposal and 21 for sealing 128 commits. The earlier 35/34/18 counts describe earlier revisions. The current counts stay within the E2E ceilings of 45/45/64. [Full current verification](evidence/2026-10-15-source/derived-full-e2e.txt) also preserves zero-blob-I/O reconstruction.
