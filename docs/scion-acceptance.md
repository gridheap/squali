# Fixed Scion acceptance checklist

This checklist measures implementation coverage of [Anthropic's public Scion design](https://www.anthropic.com/engineering/redesigning-source-control). Anthropic has not released a complete implementation or conformance suite. The percentage is this project's engineering criterion, not an Anthropic certification or a predicted competition score.

The denominator is fixed at 20. At least 19 must pass, and items **3, 4, 5, 6, 13 and 15** are mandatory. Partial implementations receive no fractional credit. Complete private-import validation, cost reconciliation and the final video are additional release gates.

**Current decision: hold submission.** The core implementation has local E2E evidence, but the large private import has not completed its independent production validation. No final percentage is reported.

## Fixed requirements and evidence

The [current full report](evidence/2026-10-15-source/native-nonatomic-full-e2e.txt) runs the API/CLI tests named below. [The evidence guide](evidence/2026-10-15-source/README.md) retains failure reports and earlier checkpoints.

| # | Requirement | Completion criterion | Evidence / remaining gate |
|---|---|---|---|
| 1 | Online source API | Read and write through authenticated APIs without a client repository | `source.test.ts`, `api.test.ts`, deployed source API |
| 2 | Client/server separation | Clients handle files/cache; the server performs source operations | `sparse.test.ts`, `metadata.test.ts`, writable sparse client, bounded native filesystem watcher and node daemon; FUSE remains read-only |
| 3 | Immutable incremental changesets | Durable first-parent deltas and content identities reconstruct the version | `source.test.ts`: remove compatibility metadata, rebuild identical trees/commits, preserve historical modes and non-UTF-8 commit bytes |
| 4 | Independent change creation | Creating changes does not move refs or coordinate main | `source.test.ts`, `publication-cost.test.ts`: no proposal refs, zero Artifacts calls, separate publication CAS |
| 5 | Distributed content storage | The source service does not need a complete repository on one node; source survives Git compatibility limits | R2 authority and SQL canonical deltas; source-limit E2E passes. **Large private production gate pending** |
| 6 | Commit graph | Generation, skip pointers, all-parent ancestry and merge bases | `graph.test.ts`: 1,025 commits, restart, criss-cross bases, second-parent ancestry; **large production graph gate pending** |
| 7 | Path history and blame | Indexed path queries and reusable recursive line origins | `source.test.ts`: skip 511 unrelated commits; `derived-indexes.test.ts`: native edited-rename blame and reusable parent results; final private comparison pending |
| 8 | Server diff | Compare immutable versions and selected paths | `metadata.test.ts`; bounded API, CLI and browser workflow |
| 9 | Commit, merge and rebase | Complete source writes, merges and recoverable rebase conflicts | `api.test.ts`, `rebase.test.ts`: continuous rebase, restart, explicit resolution, fresh review, native Git tree equality |
| 10 | Revert and bisect | Locate, verify and withdraw a change through usable workflows | `bisect-run.test.ts`: 16 commits, six executed tests, retained journal; reviewed revert in `metadata.test.ts` |
| 11 | Generic derived data | Versioned parent dependencies, eager/lazy computation and reconstruction | `derived-indexes.test.ts`: graph/path/tree/generation and blame share one resolver; head-only rebuild after restart, preserved multi-parent ancestry, bounded inputs, cache identity reuse |
| 12 | Sparse client lifecycle | Select, hydrate, add/edit/delete, propose, update and recover | `sparse.test.ts`: explicit additions, native identity, process kill, protected local edits, executable modes |
| 13 | On-demand filesystem | Ordinary filesystem reads trigger content hydration | [Real Linux FUSE evidence](evidence/2026-10-15-source/fuse-green.json): `ls`/`stat` fetch no content; `cat` fetches bodies. Immutable mount; writes use sparse client/API |
| 14 | Shared node daemon | Multiple workspaces share a bounded cache and concurrent misses | `node-cache.test.ts`: 12 readers coalesce a miss; two real FUSE mounts share the daemon |
| 15 | Tiered immutable protocol | Each tier serves the same object RPC; authorization precedes cache; failures cannot bypass tiers | `node-cache.test.ts`, `source-cache.test.ts`, `storage.test.ts`; head/object/stat over HTTP and a private Unix socket |
| 16 | Failure isolation | Cache outages and uncertain writes do not amplify origin load | Upload leases, identity checks, late acknowledgements, differing gzip representations and single-writer recovery; retained real interrupted import |
| 17 | Cache snapshots | Verified refresh/restore and measured startup reuse | `node-cache.test.ts`; real FUSE 2.275 s first sample, 1.284 s repeated sample with zero new content requests |
| 18 | Directory IAM | Reads, writes, history and cache paths honor scope | `permissions.test.ts`, `github.test.ts`: owner isolation, revocation, path credentials and blocked raw/index escape routes |
| 19 | Semantic review | Supported semantic constraints distinguish comment/value changes from logic changes | `semantic.test.ts`: parsed JavaScript and JSON, protected directives, duplicate-key rejection, checks at review and publication |
| 20 | Selected publication | Dependencies, conflicts, exact review versions, main update and recovery form a complete flow | `api.test.ts`, `crash.test.ts`, `publication-cost.test.ts`; 64 changes / eight clients locally and in retained production sample |

## Extra release gates

1. The private fixture's 421,219 objects, 85,563 commits, 1,020 refs and 8.33 GB raw history complete source ingestion and native seeding. One retained verification clone must pass fsck and full object/ref equality. Root tree and selected history/blame must match the native input. A bounded canonical-delta sample must independently match native paths, hashes, parent mappings and original commit metadata.
2. Production Clerk/GitHub sign-in and private catalog are verified; the completed private workspace must also pass its browser workflow.
3. Reconcile final application reservations with provider metrics, preserving reporting lag, failed attempts, Azure costs and ongoing storage exposure. Reuse existing successful performance samples.
4. Record and inspect the current 5–10 minute demonstration, review the runnable open-source package, and let the eligible team member personally submit the entry.

## Explicit boundaries

The native Git importer has one active job and a cached input, while normal source operations do not require that cache. The present PostgreSQL origin has not demonstrated Spanner-scale throughput. The FUSE mount is read-only; the writable sparse client has an explicit bounded filesystem monitor and submits edits on command. There is no dedicated regional cache fleet or measured 99% cache hit rate. Text, graph, rename and export operations have published limits. These boundaries must remain visible in any final coverage claim.
