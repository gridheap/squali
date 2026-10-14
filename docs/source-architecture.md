# Scion storage migration

The authoritative unit is an immutable changeset containing its parents and first-parent file delta. Each file delta points to an individually compressed, content-addressed R2 blob. PostgreSQL's durable log records changesets; no proposal ref is created. Only explicit publication updates a ref with compare-and-swap. Git trees and commit records are compatibility/derived data and can be rebuilt from the changesets. Git packs are import/export transport only and are not authoritative R2 storage.

Existing Artifacts workspaces keep their current adapter until the new path passes acceptance. Source-backed workspaces expose the same authorized HTTP object and source APIs. Artifacts remains the bounded Git interoperability bridge. No D1 or application Durable Object is introduced.

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

Versioned tree/generation derivation and graph/path index rebuilding now have native-Git equivalence evidence. The authority preserves raw commit metadata (including non-UTF-8 encodings) and historical regular-file modes separately from normalized display modes. Independent changesets retain their first-parent deltas, and compatibility tree/commit tables can be deleted and reconstructed. Path-event indexes skip unrelated file churn; cursors bound branch-candidate scans.

Source uploads permit 32 MiB individual blobs, 64 MiB expanded batches, and 1 MiB compressed JSON batches; larger compressed blobs use the binary endpoint. Unknown upload outcomes are checked by immutable key. A confirmed missing object can be explicitly retried after its lease expires, at most three attempts and still within the monthly write cap. There is no automatic whole-import retry.

## Native GitHub job runner (next vertical slice)

One click queues a persistent PostgreSQL job. A single native runner listens on the existing database; it does not poll a paid Cloudflare endpoint when idle. A session advisory lock bounds the fleet to one active runner. GitHub credentials are delivered only to a short-lived, project-specific job credential, never persisted in a clone URL or sent to the browser. The Worker retains the Clerk secret. Existing native caches and importer journals are reused.

Each job has finite object/byte/request budgets, a cumulative execution budget and at most three user-triggered recovery attempts. Child process and journal locks prevent duplicate runners. Partial uploads retain content-addressed progress. Queue state, running progress, failure, pause and completion are owner-scoped. Closing the browser does not cancel a started native job. Idle wakeups are database notifications; missed notifications are reconciled by a bounded local database check.

Failure specification: two runners claim one job; a job reads another owner's GitHub credential; a project token calls the job-credential route without a matching live lease; ref changes cause a restart under the old journal; a process dies before its checkpoint; a clone is repeated despite a valid cache; an import finishes without all refs/objects/changesets; paused or exhausted jobs resume themselves; a public request allocates unbounded disk, memory, processes or HTTP attempts. Test the full login/catalog/enqueue/worker/native-Git/API path using local GitHub and Clerk fixtures, plus a single bounded production sample after acceptance.
