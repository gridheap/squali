# Squali and the public Scion design

Source: [Anthropic, Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control), October 13, 2026. Checkpoint: October 15.

Squali now uses independent immutable changesets and R2 source blobs. The current acceptance boundary is the [fixed 20-item checklist](scion-acceptance.md), with mandatory architecture gates and additional private-import, performance and cost gates. Final competition submission is still pending. The percentage describes coverage of the published design; Anthropic has not published a complete implementation or conformance suite.

| Article capability | Implemented and tested | Remaining boundary |
|---|---|---|
| Online clients; optional working copy | Authenticated source, metadata and change APIs; HTTP CLI, sparse working copy and bounded native file monitor | The CLI implements the documented workflows, rather than every Git command |
| Immutable incremental changesets | SHA-256 changeset identity, parent identities, first-parent file deltas, compressed content-addressed blobs; no proposal refs | PostgreSQL admission counters still coordinate finite usage budgets |
| Separate publication | Reviewed subset/dependencies, reconciliation, immutable revisions and CAS on the published ref | One authoritative main update remains serialized |
| Server operations | Diff, commit, merge, single-commit and continuous rebase, conflicts, revert, executable bisect | Continuous rebase: 64 single-parent commits, eight steps/request; merge commits use explicit-parent rebase |
| Commit graph and path history | Eager generation/skip index, multi-parent ancestry/merge bases, indexed path events, history and blame | General graph traversal: 50,000-node budget; history and path queries are paginated |
| Derived data | Versioned recursive derivation, eager/lazy evaluation, parent-dependent blame, rebuilding trees/commits/indexes from canonical deltas | One shared dependency engine with vectorized graph/path adapters; bounded reconstruction, no automatic background backfill |
| Virtualized files | Actual Linux FUSE mount: ordinary `ls`, `stat` and `cat`, metadata without file bodies, lazy content | FUSE mounts are immutable/read-only. Writable changes use the sparse working-copy client/API |
| Node daemon and tiered cache | Private Unix socket, concurrent miss coalescing, bounded shared cache, verified snapshots, Worker memory/edge and durable R2 | No dedicated regional cache fleet or measured 99% hit rate at every tier |
| Fault isolation | Cache errors fail closed, upload leases and late-ack reconciliation, revoked credentials, bounded snapshots, no authority bypass | Same-user local cache directories are not an OS security boundary between hostile processes |
| IAM and review constraints | Clerk owner isolation, expiring role/path credentials, parser-backed JS comment-only and JSON value policies | Semantic scope is explicit; it is not general proof of program equivalence or trusted CI attestation |
| Private GitHub import | Persistent background jobs, single native worker, frozen cache/journal, pause/resume, short internal credential leases, no browser pack transfer | Real production GitHub login and the private catalog pass; full 421,219-object private import remains in progress |
| Git interoperability | Published-only Artifacts export, incremental clone/fetch, native cache seeding, exact tags, lost-ack reconciliation, rebuildable derived copy | Worker export: 8,192 new objects/16 MiB; Artifacts remains limited to a 1 GB compatibility repository |
| Performance and independent storage | Stateless Workers; durable R2 blobs; SQL changesets; batch-sealing 128 commits reduced from 1,793 to 21 SQL queries in the retained local fixture | Production concurrency and database metrics are retained; final large-repository verification and cost reconciliation remain pending |

## Responsibilities

- **Workers:** authentication, path policy, bounded queries/writes, source RPC and usage admission. They do not unpack a complete imported Git repository.
- **R2 `SOURCE`:** authoritative independent gzip blobs, addressed by SHA-256. Completed source objects do not expire.
- **PostgreSQL through Hyperdrive:** canonical changesets, derived compatibility metadata/indexes, identities, review policy, journals and usage reservations.
- **Artifacts:** derived Git interoperability copy. Source queries, changesets and publication do not require proposal refs or Artifacts calls. Legacy workspaces retain their old adapter.
- **R2 `OBJECTS`:** disposable compatibility cache with seven-day expiry; separate metering from authoritative source storage.
- **Native importer:** one existing Azure VM, one active job, cached Git input, cumulative eight-hour job limit, bounded HTTP/object/byte budgets and at most three explicit recovery attempts. Successful bounded segments continue the same job; failed jobs do not restart themselves.
- **Client/node:** sparse writable client, shared socket daemon, verified bounded cache/snapshot, Linux FUSE on-demand reads.

There is no D1 or application Durable Object. Scion's 100 GB history, 25 GB working copy, 25 million daily checkouts, 99% cache hit rates and 200× infrastructure reduction are **Anthropic's measurements**, not Squali's results. Local benchmark numbers are labeled as such.

See [source architecture](source-architecture.md), [source budget](source-import-budget.md), [evidence](evidence/2026-10-15-source/README.md), [readiness](readiness.md), [API](api.md) and [working copy](working-copy.md).
