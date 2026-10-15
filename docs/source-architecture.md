# Scion storage migration

The authoritative unit is an immutable changeset containing its parents and first-parent file delta. Each file delta points to an individually compressed, content-addressed R2 blob. PostgreSQL's durable log records changesets; no proposal ref is created. Only explicit publication updates a ref with compare-and-swap. Git trees and commit records are compatibility/derived data and can be rebuilt from the changesets. Git packs are import/export transport only and are not authoritative R2 storage.

Existing Artifacts workspaces keep their current adapter until the new path passes acceptance. Source-backed workspaces expose the same authorized HTTP object and source APIs. Artifacts remains the bounded Git interoperability bridge. No D1 or application Durable Object is introduced.

If Artifacts reports its repository storage limit, the native consumer can derive one immutable Git compatibility snapshot from the retained input pack. R2 stores SHA-256-verified chunks; Workers serves authenticated Git HTTP reads with byte ranges. This copy is supplementary transport data. Canonical changesets and independent blobs remain authoritative, and subsequent publication is served as incremental loose Git objects without rebuilding the frozen pack.

A native importer reuses the existing Git object database. It sends bounded object batches, skips already admitted objects, verifies both Git IDs and blob content hashes, and imports changesets in parent order. Immutable refs and the source inventory define a resumable import. Large imports use per-batch limits and persistent total-attempt and byte ceilings; no complete Git pack is buffered or decompressed by a Worker.

Authoritative blobs have no expiry policy. Disposable caches retain their existing expiry. Each R2 operation reserves its source-store budget separately from cache and Artifacts reservations. Failed or ambiguous operations count. Missing authoritative storage fails closed.

## Failure specification and public acceptance seams

Use authenticated HTTP and CLI, real PostgreSQL, a persistent filesystem adapter at the R2 boundary, and independent native Git comparisons. Production uses the real R2 binding after bounded local acceptance.

- Creating a changeset writes or moves a Git ref, serializes unrelated commits, or hides it until main moves.
- A delta omits deletion/mode changes or cannot reconstruct its tree from its first parent.
- A body is accepted under the wrong Git/content identity, malformed tree or unsupported compression; compression expands beyond its admitted bound.
- Blob upload or SQL finalization fails halfway, causing a missing authoritative object, duplicate billable upload, or false completion.
- Replaying a finished immutable input performs another provider operation; concurrent uploads race or leave an unrecoverable claim.
- An unauthenticated, directory-scoped or foreign owner reads an object through a cache or import shortcut.
- Main CAS loses an update; publication/cancellation recovery bypasses review or changes deterministic identity.
- Ref/tag/tree/parent closure is incomplete when an import is marked ready.
- Import restart downloads or uploads the entire repository again; usage is not bounded across restarts.
- A native Git export differs in trees, modes, history or tags, or accesses source objects from another workspace.
- Object count or repository bytes are assumed to fit one server's disk/memory, or the Artifacts 1 GB bound silently truncates a source-backed workspace.

## Implementation checkpoint

Tree, generation, graph, path and blame results share one versioned dependency resolver. Eager import/proposal batches and lazy rebuilds use the same ordering, cache reuse, cycle checks and finite dependency bounds; storage and vectorized calculations remain adapters. A path completion marker is written after its event rows, including empty deltas. Removing indexes and restarting can rebuild a head and its parents without blob I/O. Native-Git equivalence and multi-parent graph preservation have retained E2E evidence. The authority preserves raw commit metadata (including non-UTF-8 encodings) and historical regular-file modes separately from normalized display modes. Independent changesets retain their first-parent deltas, and compatibility tree/commit tables can be deleted and reconstructed. Path-event indexes skip unrelated file churn; cursors bound branch-candidate scans.

Source uploads permit 32 MiB individual blobs, 64 MiB expanded batches, and 1 MiB compressed JSON batches; larger compressed blobs use the binary endpoint. Unknown upload outcomes are checked by immutable key. A confirmed missing object can be explicitly retried after its lease expires, at most three attempts and still within the monthly write cap. There is no automatic whole-import retry.

## Native GitHub job runner

One click queues a persistent PostgreSQL job. A single native runner listens on the existing database; it does not poll a paid Cloudflare endpoint when idle. A session advisory lock bounds the fleet to one active runner. GitHub credentials are delivered only to a short-lived, project-specific job credential, never persisted in a clone URL or sent to the browser. The Worker retains the Clerk secret. Existing native caches and importer journals are reused.

Each job has finite object/byte/request budgets, a cumulative execution budget and three user-triggered recovery attempts by default, with at most one documented operator extension for a specific job inside its original total budgets. Child process and journal locks prevent duplicate runners. Partial uploads retain content-addressed progress. Queue state, running progress, failure, pause and completion are owner-scoped. Closing the browser does not cancel a started native job. Idle wakeups are database notifications; missed notifications are reconciled by a bounded local database check.

Failure specification: two runners claim one job; a job reads another owner's GitHub credential; a project token calls the job-credential route without a matching live lease; ref changes cause a restart under the old journal; a process dies before its checkpoint; a clone is repeated despite a valid cache; an import finishes without all refs/objects/changesets; paused or exhausted jobs resume themselves; a public request allocates unbounded disk, memory, processes or HTTP attempts. Test the full login/catalog/enqueue/worker/native-Git/API path using local GitHub and Clerk fixtures, plus a single bounded production sample after acceptance.

## Background importer and review acceptance

`native-jobs.py` uses one PostgreSQL connection and a fleet-wide session advisory lock. The Worker enqueues jobs and returns without transferring a pack. Jobs retain native Git caches and the cumulative importer journal. A short-lived project credential must also match the current job lease before the Worker releases a GitHub OAuth credential. Browser owners and ordinary project tokens cannot call that credential route. The runner passes the GitHub secret to Git through process environment, with redirects and interactive credential helpers disabled; clone URLs and saved configuration have no credentials.

The current deployment admits 100 workspaces under the same monthly source and Artifacts operation limits. It has one existing Azure worker, a 1 GiB memory limit, and no new VM, D1 or application Durable Object. The service restarts after its finite process lifetime (1,000 jobs or eight hours), with at most three starts per hour. Job time, attempt and monthly operation limits persist across restarts; failed jobs remain stopped. Idle work is one database notification connection with 30-second reconciliation, with no paid idle HTTP polling.

Continuous branch rebase now checkpoints up to eight of at most 64 single-parent commits per request. Source and target identities are frozen. Conflicts retain their cursor and can be resolved through the same operation; a completed replay is stable. New commits require fresh approval, and main is untouched. Merge commits still use the existing explicit-parent individual rebase operation.

The Adobe cold-load test observed a connection taking longer than the 2.8 second CSS budget. The page locked to native fallback. One warm navigation resolved actual Proxima Nova Latin glyphs and platform PingFang SC CJK glyphs through CDP. This proves the configured success and fallback paths; it does not claim universal cold Adobe rendering within that budget.

## Git export bridge: failure specification

Source-backed Git clone/fetch must preserve published refs and exact Git objects without making Artifacts authoritative. Unpublished proposal objects must not be reachable through an export pack. The bridge stores which immutable objects it has confirmed, so subsequent publication exports only the new closure and repeat clones perform no source blob fetches. Unknown push acknowledgements reconcile provider refs before any retry. Unexpected provider refs fail closed. Project-scoped authorization remains outside the gateway and directory-scoped credentials cannot use it.

Worker exports are bounded to 8,192 new objects and 16 MiB of expanded object content. A larger initial import needs a native Git seed from its existing compressed input cache; a short-lived provider write credential must be restricted to the live internal job lease. The native path must reconcile exact branches/tags before recording the seed, obey the Artifacts repository limit, and retain R2/PostgreSQL as the source of truth. Deleting the derived Artifacts copy must leave source APIs and changesets intact, with an explicit bounded rebuild path.

A healthy import that reaches a per-process checkpoint must continue in the same job, without another GitHub transfer or a new attempt. Its persistent HTTP budget and cumulative eight-hour job budget still apply. Failed segments never restart themselves. Validation forces a one-second segment with a delayed storage acknowledgement, then checks that the next segment reuses the accepted objects and native cache.

## Batch ingestion performance

The native importer reuses one HTTP connection per process and does not automatically retry disconnects or ambiguous acknowledgements. Changeset sealing loads changed trees by level, resolves blob metadata in batches, and commits changesets, path events and graph metadata together. A 128-commit fixture fell from 1,793 SQL round trips to 18. The batch admits at most 16 MiB metadata, 8,192 changed trees, 250,000 decoded tree entries and 100,000 changed paths. Larger inputs require smaller batches; a failed batch does not publish partial canonical changesets.

## Small database pools and compatibility capacity

Semantic review reads immutable content before its short transaction, then enforces the current policy inside that transaction. If policy changes require additional content, the operation stops for a fresh review. Continuous rebase advances a durable result with compare-and-swap and deterministic proposal IDs. Git export holds a ten-minute SQL lease while it performs network work, then atomically confirms its index; it does not pin a database connection during provider I/O. Single-connection E2E covers all three paths, including independent exports and exclusion of a duplicate export.

The native source importer can finish independently when the compatibility copy exceeds Artifacts' 1 GB limit. Its journal records the limit and source status reports `gitCompatibility.state=provider_limit`; the Git endpoint returns a specific 413 while source APIs remain usable. A lower `--git-export-max-bytes` can target a more restrictive compatibility destination. The limit never increases the source HTTP or byte budgets. A metadata batch rejected by `source_seal_budget` is split in half, with its smaller size persisted; rejected calls still consume the cumulative HTTP budget. Other failures stop.

For an explicit `artifacts_git_receive_pack_storage_limit` response, the background consumer selects a bounded R2 snapshot in the same job. Its original request and time budgets remain authoritative. Snapshot admission is 500,000 objects, a 512 MiB pack, a 16 MiB v2 index and 8 MiB chunks. Server activation verifies checksums, unique sorted index membership against the admitted source inventory, fanout and offsets. A separate native clone/fsck checks the complete exported repository. The snapshot state is `r2_snapshot`; inputs outside its bounds remain explicitly limited. Upload leases reconcile unknown acknowledgements before retrying; confirmed chunks and completed snapshots incur no repeated storage operations. Snapshot failures stop until explicit recovery, with at most two uploader attempts and two validation passes.

## Publication content reuse

Independent approved changes retain their verified blob identities and byte lengths. Preview/publication reuse those identities and only load text when conflict reconciliation or semantic policy needs it. The incremental Git pack contains new trees/commits; existing blobs are not downloaded and repacked. The source adapter uses the batch sealing path for interactive writes as well as import. A 64-change HTTP E2E verifies preview plus publication with 64 SQL queries, zero blob reads and zero blob writes; before the change the same test incurred 128 blob reads. Legacy proposals without saved lengths fall back to reading the content.

The initial real cloud sample published 64 changes in 26.95 seconds. After the content-reuse change, a smaller eight-change smoke published in 2.25 seconds. These are different sample sizes and do not establish a speedup ratio. Both ran while the private import was active. CPU and I/O metrics show the database was not saturated; Hyperdrive observed connection wait during concurrent requests. The Worker now limits each request to one database connection and lazily shares its immutable project lookup within the request.

The resolver admits at most 1,024 missing results and 8,192 dependency records per invocation. Graph/path reconstruction additionally bounds metadata to 16 MiB, and path derivation to 100,000 events. Larger rebuilds use parent-order batches. Graph skip pointers are computed by level with shared database reads; 128-commit sealing uses 17 SQL queries in the current retained fixture.

Blame declares its path-stable and parent line results as dependencies in that same engine. Existing `blame-renames-v1` cache identities are preserved. A rebuilt head may fetch its current body and a rename candidate; completed parent line results are reused, and a complete hot result adds no source I/O. Other cached metadata query results use the shared resolver as leaf definitions.

### Verified immutable object cache

The Worker uses the same project-scoped cache path for source commits, trees, tags and admitted blobs. Each binary record includes the kind and SHA-256 checksum; each read also validates the Git object identity. A warm object does not query PostgreSQL source rows or read R2. Authentication, workspace state and path permissions remain live checks before object access. Cache failures stop at that tier. The local HTTP acceptance sample reduces repeated source-row queries from 11 to zero; this is separate from production latency measurements.
