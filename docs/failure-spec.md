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
