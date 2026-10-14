# Contract and failure specification

Public seams are the HTTP API, browser UI, and standard Git clone. These implement the requested E2E-first verification. No implementation-internal unit tests.

## Invariants

- Unauthenticated clients cannot read source, allocate repositories, or perform mutations. Agents cannot approve or publish. Credentials never appear in logs or browser storage.
- Project and change IDs, paths, payloads, dependency lists, request sizes and batch sizes are bounded. Traversal, .git paths, symlink traversal, ambiguous file/directory replacements and malformed IDs are rejected.
- A changeset is immutable and points to an immutable Git commit. Its base, intent, author, evidence, dependencies and original files remain recoverable.
- Reusing an idempotency key with the same payload returns the original result; a different payload is rejected. An incomplete attempt can be recovered without silently creating a duplicate repo or ref.
- Concurrent independent changes are retained. Overlapping edits are either merged by a deterministic three-way text merge or returned as explicit conflicts. Deletions, additions and binary changes never lose data silently.
- Approval is tied to the immutable change. Revisions require new approval. Required dependencies must land first or in the same ordered batch.
- Publishing uses Git's expected-old-object CAS. External Git pushes cannot be overwritten. A crash between Git push and SQL finalization is recoverable by retrying the same publication ID.
- External calls have a persisted monthly reservation counter and bounded retries. Unknown outcomes consume budget. Missing caps fail closed. There are no background paid loops.
- Source is read by explicit path or tree; a commit rewrites changed blobs and ancestor trees only. No full clone or full tree traversal on the commit path.
- Git cloning must reproduce the exact final file contents and history.

## Browser

Connect -> create workspace -> submit parallel changes -> review diff/context -> approve -> preview batch -> publish -> inspect history. Controls must show backend errors, loading and success. Small screens remain usable. Render untrusted source as text. Missing Adobe project uses explicit native fallback; a configured project has bounded loading, no late swap, and navigation reuses one loader.

## Bounds and honest claims

Local fixtures use real PostgreSQL and a local Git HTTP backend. They prove behavior, not Cloudflare latency, provider billing, or a 100,000-agent workload. A bounded live Artifacts smoke test is separate. A benchmark records hardware, command, concurrency, operation counts, percentiles, failures and dataset. No claim of universally highest performance without comparative evidence.

## Small PostgreSQL connection pools

A transaction that waits for an Artifacts call can exhaust the origin pool when that call reserves its budget through another SQL connection. Publication journals written through a second connection can cause the same starvation. The HTTP workflow must complete with one available PostgreSQL connection, including concurrent proposals, publication and revision. No database transaction may wait for a provider call or another transaction. Durable preparing records must preserve idempotency and protect review state while Git I/O runs outside a transaction.

## Completion audit: multi-file revisions and usage

The browser must render all files of a proposal when revising it. Editing one file must preserve the other original edits, including deletions and executable modes. Users must be able to add/remove file edits explicitly. A revision must preserve original intent/context and require fresh approval. The cost view must read the deployment's persisted reservation counter and cap, display errors, and must not present provider list prices as measured usage or a bill.

## Actual process termination

Kill the local application process with SIGKILL after the independent native Git server has accepted a publication, before the application acknowledges it or finalizes PostgreSQL. Restart against the same data. The original HTTP publication request must finalize that exact commit and emit one publication event even if the original active marker survived. This acceptance case does not prove recovery before Git acceptance or safe cancellation of a delayed push.

## Clerk identity and GitHub import

Public acceptance seams remain the HTTP API, browser UI and standard Git. Failure cases: forged/expired/wrong-origin/wrong-issuer Clerk session; token used across owners; account switch retaining another owner's data; missing or revoked GitHub scope; organization restrictions; repositories beyond page one; renamed/private/empty repositories; duplicate selections and simultaneous imports; provider rate limit; interrupted transfer and lost acknowledgement; limits exceeded midway; partial success; credentials in logs or URLs; branch/tag/history loss; non-main default branch; Git LFS/submodules silently omitted; repeated clicks charging again; reload losing progress; Adobe loading preventing sign-in or import feedback. Imports create an independent private copy; they must never push to GitHub. Every repository must retain all advertised heads and tags and full Git history. LFS objects and submodule repositories require explicit separate handling, and the UI must disclose that scope before import.

Import admission must preserve database capacity: with one import paused after Git acceptance, a second import request must return a bounded 409 response without acquiring a second long-lived coordination transaction. Resume after termination must not transfer the accepted pack again.

## Publication retry and cancellation ordering

Use the public HTTP API and native Git for acceptance. Kill the process before Git acceptance and after Git acceptance. Retrying the same publication under another authorized reviewer must retain the original commit, author and timestamp. Concurrent retries must converge on that commit and emit one event. Neither a persisted active marker nor a lost response can permanently block recovery.

Cancellation must be ordered by Git's expected-old-head comparison, not by a timeout or a database flag. A successful cancellation appends an audit commit with the unchanged tree, so any delayed publication using the previous head is rejected. If publication wins first, cancellation must report that fact and allow finalization. A crash before or after accepting the cancellation commit must be recoverable with the same cancellation request. External head changes require reconciliation and must never be overwritten. All database transactions remain short and contain no provider I/O; the workflow still progresses with one PostgreSQL connection.

## Bounded native Git comparison

The comparison runs only on the local Git HTTP server and PostgreSQL. Both paths start with the same 64 files and 32 independent one-file changes, eight clients, retained proposal branches, and one final squashed publication. Native clients reuse eight initialized clones; initialization is reported separately. Squali proposals include its authorization, SQL journal and metering; bare Git has none of these services, so this is a cost-of-functionality comparison, not a forge ranking. Acceptance requires an independently constructed expected tree, matching final Git tree IDs, all proposal refs present, and native `git fsck` success. Report failures and p50/p95/p99; no inference about cloud latency or billing.

## Native Git compressed negotiation

Native Git compresses sufficiently long upload-pack requests with gzip. The authenticated Git gateway must preserve their meaning and cap decompressed negotiation at 1 MiB before any provider call. A valid compressed request must return a real pack; malformed gzip, unknown encodings and compressed expansion beyond the limit must be rejected. Local HTTP fixtures must also support native Git's compressed requests so they can exercise the comparison accurately.

## Production runtime and large private imports

The HTTP import workflow must run with Cloudflare Workers fetch semantics (only follow/manual redirects). Redirect responses from identity, catalog or Git endpoints must fail without forwarding credentials. Large imports must remain streamed and bounded by provider capacity, with one admitted transfer, finite time and bytes, immutable ref checkpoints, and no automatic retries. Verify a real multi-hundred-MiB Git repository and exact destination refs/history, separately from authorization and owner isolation. Reject metadata over the admitted limit before Artifacts allocation. Login with identity-only scope must remain usable; repository access is an explicit later authorization.

## R2 immutable tier

HTTP reads must authenticate before local, edge or R2 caches. Replacing the Worker and edge cache must retain immutable R2 results without another Artifacts call. Duplicate content must not be uploaded repeatedly; abandoned upload claims expire only with a documented bound. R2 failures and quota exhaustion must fail closed instead of flooding Artifacts. Persist separate finite R2 read/write reservations, cap each cached object, and expire entries. Invalid object formats must never become source data. Cache failure must never lose authoritative Git objects.

## Sparse client and immutable object API

Use HTTP and the real CLI process. Select directories without copying unrelated files or Git history; hydrate individual files later. Two workspaces on one machine reuse immutable disk objects only after current authorization. Bound cache bytes, object batches and response bytes. Reject invalid object IDs, traversal, symlinks and unsafe local destinations. Never overwrite local modifications or materialize Git symlinks/submodules as normal files. Preserve executable modes, immutable base commit and exact edited paths when proposing. Cache corruption is detected by object identity; interrupted files use atomic writes. Token revocation and future path restrictions must not be bypassed by the object API.

## Server-side metadata

Use HTTP against real Git: fork two commits, reconcile their independent line changes, then verify merge bases, both-parent ancestry, changed-tree diff, paginated first-parent path history, line blame through both merge parents, bisect candidates and reviewed revert. Derived answers are immutable/versioned and reused. Invalid IDs, missing objects, unrelated histories, binary files and query bounds fail explicitly; a truncated traversal must never produce a false ancestry/merge-base result. Revert is a new proposal and cannot overwrite later edits. Queries do not run repository code.

Publications now preserve accepted proposal commits as additional Git parents, so native ancestry and blame retain agent authorship. The original main commit remains the first parent. Freeze the parent list in the publication journal before constructing the pack; recovery of older journals without this field retains the former single-parent format. Cancellation commits do not acquire proposal parents.

## Directory permissions and approval policy

Restrict a real owner-issued credential to one directory. Verify file, tree, native Git, raw object, diff, event, proposal details/list, dependencies, review, revision and publication paths cannot reveal or change another directory. Directory scopes are boundary-aware, not raw string prefixes. A restricted token cannot mint broader tokens or policy. Policies require independent approval and supplied evidence on matching paths; updating a policy invalidates earlier approvals. Evidence remains self-reported, not proof of command execution. Use the publication lock to prevent policy changes while a publication is in flight.

### Large binary materialization

A large imported Git blob must not be mistaken for an editable UTF-8 file. Raw reads must reject unauthorized paths before object access, preserve exact bytes and executable modes, validate immutable identities, cap one object at 32 MiB, and avoid unbounded cache growth. The CLI must not route binary files through base64 JSON object batches with a 1 MiB response limit. Editing remains limited to 256 KiB UTF-8 files. A warm shared cache must not widen a narrower credential.
# Indexed commit graph

The public seams are the authenticated HTTP index/metadata endpoints and native Git interoperability, continuing the existing E2E acceptance boundary.

- A deep history exceeds the old 256-commit request ceiling; a bounded indexing step must resume without returning a false ancestry result.
- An interrupted or overlapping indexing request loses progress or falsely marks an incomplete parent graph complete.
- An indexed graph is queried for a previously unseen pair; this must not reread every commit from the provider.
- First-parent skip pointers accidentally discard second parents or return only one merge base in a criss-cross graph.
- Disconnected histories, identical IDs, missing commits, invalid limits and unindexed tails produce incorrect results.
- A directory-scoped or non-administrative credential starts a bulk index or accesses hidden graph metadata.
- Index computation or traversal runs without a finite provider, node, memory or request budget.
- Cached graph data from another project or a prior algorithm version contaminates results.
- Bulk metadata supplies a forged commit body, an unrelated object, or a child with an untrusted root; verify native Git object hashes and parent reachability from a provider-anchored commit before accepting it.
- Repeating a successful metadata upload rereads the provider or duplicates stored records.

# Working-copy completion

Public seam: working-copy CLI connected to the real HTTP application, PostgreSQL and Git.

- A newly created regular file cannot be explicitly added and proposed without a Git clone.
- Adding an existing remote file outside the sparse view silently replaces unseen content.
- Traversal, symlinks, out-of-scope paths, binary or oversized additions escape the client or editing limits.
- Updating loses dirty content, changes executable modes, deletes untracked data, or fails to retain hydrated paths.
- Remote deletion or an empty sparse directory prevents an otherwise valid update.
- An interrupted update leaves files and manifest inconsistent; a resume overwrites edits made after interruption.
- Network failure halfway through download mutates the working tree before all required objects are available.
- Cache/working-copy data is reused across a revoked or narrower credential without authorization.
