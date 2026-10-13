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
