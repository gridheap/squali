# Fixed Scion acceptance checklist

> **Superseded status, October 15:** competition submission is paused at the user's request. No entry has been submitted. The release checklist below describes v0.2.0 within its original bounds; it does not establish 95% Scion equivalence or overall goal completion. See [continued implementation and open gaps](scion-next.md).

This checklist measures implementation coverage of [Anthropic's public Scion design](https://www.anthropic.com/engineering/redesigning-source-control). Anthropic has not released a complete implementation or conformance suite. The percentage is this project's engineering criterion, not an Anthropic certification or a predicted competition score.

The denominator is fixed at 20. At least 19 must pass, and items **3, 4, 5, 6, 13 and 15** are mandatory. Partial implementations receive no fractional credit. Complete private-import validation, cost reconciliation and the final video are additional release gates.

**Capability decision: all 20 fixed completion criteria pass, including mandatory items 3, 4, 5, 6, 13 and 15.** This clears the ≥19/20 engineering threshold within the explicit boundaries below. It does not measure the percentage of Anthropic’s unpublished implementation. The large private import, independent native comparison, production browser workflow and cost reconciliation have passed. Final media/package inspection also passed: [410.2-second current video and reports](evidence/2026-10-15-source/demo-final/). Competition submission remains a human action.

## Fixed requirements and evidence

The [current full report](evidence/2026-10-15-source/imara-final-suite.txt) runs the API/CLI tests named below. [The evidence guide](evidence/2026-10-15-source/README.md) retains failure reports and earlier checkpoints.

| # | Requirement | Completion criterion | Passing evidence |
|---|---|---|---|
| 1 | Online source API | Read and write through authenticated APIs without a client repository | `source.test.ts`, `api.test.ts`, deployed source API |
| 2 | Client/server separation | Clients handle files/cache; the server performs source operations | `sparse.test.ts`, `metadata.test.ts`, writable sparse client, bounded native filesystem watcher and node daemon; FUSE remains read-only |
| 3 | Immutable incremental changesets | Durable first-parent deltas and content identities reconstruct the version | `source.test.ts`: remove compatibility metadata, rebuild identical trees/commits, preserve historical modes and non-UTF-8 commit bytes |
| 4 | Independent change creation | Creating changes does not move refs or coordinate main | `source.test.ts`, `publication-cost.test.ts`: no proposal refs, zero Artifacts calls, separate publication CAS |
| 5 | Distributed content storage | The source service does not need a complete repository on one node; source survives Git compatibility limits | R2 authority and SQL canonical deltas; source-limit E2E passes. [421,219-object private import and clone/fsck passed](evidence/2026-10-15-source/private-verification.json) |
| 6 | Commit graph | Generation, skip pointers, all-parent ancestry and merge bases | `graph.test.ts`: 1,025 commits, restart, criss-cross bases, second-parent ancestry; production 1,024-step ancestry and native merge-base equality passed |
| 7 | Path history and blame | Indexed path queries and reusable recursive line origins | `source.test.ts`: skip 511 unrelated commits; `derived-indexes.test.ts`: native edited-rename blame and reusable parent results; `blame-native.test.ts`: EOF, empty-line and merge-parent identity; production README history/blame match native Git |
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

## Additional release evidence

1. **Passed:** [independent verification](evidence/2026-10-15-source/private-verification.json): 421,219 objects, 85,563 commits and 1,020 refs equal the frozen native input; native fsck, root tree, README content/history/blame, graph queries and eight canonical deltas match. One rejected proposal verifies writes without moving published refs. One clone and 40/48 HTTP attempts; no repeated full import.
2. **Passed:** [production Clerk/GitHub and private workspace browser acceptance](evidence/2026-10-15-source/private-browser-acceptance.md).
3. **Passed:** [provider/application cost reconciliation](cost-final.md), including failed attempts, reporting lag, shared Azure capacity and ongoing storage. Existing successful load samples are reused.
4. **Passed:** [current continuous video and reproduction](demo-source.md), decoded video/audio inspection, runnable source package and [independent final review](evidence/2026-10-15-source/review-snapshot.md). Competition entry remains a human action under the official rules.

## Explicit boundaries

The native Git importer has one active job and a cached input, while normal source operations do not require that cache. The present PostgreSQL origin has not demonstrated Spanner-scale throughput. The FUSE mount is read-only; the writable sparse client has an explicit bounded filesystem monitor and submits edits on command. There is no dedicated regional cache fleet or measured 99% cache hit rate. Text, graph, rename and export operations have published limits. These boundaries must remain visible in any final coverage claim.
