# Competition submission material

**Draft only. Full Scion parity and the large private import are not accepted yet. The linked video predates the new source-service and R2 features. Do not submit this as final.**

## Project

**Squali — source control for parallel agents.**

Live application: https://squa.li

Repository: https://github.com/gridheap/squali

License: MIT. The local application runs with PostgreSQL and Git; the production adapter targets Cloudflare Workers, Artifacts, R2 and Hyperdrive. No D1 or application Durable Objects are used.

## Vision (form draft)

AI agents can write code in parallel, but people still have to reconstruct why each edit exists, decide which changes belong together, and recover when a publication partially succeeds. Squali makes an immutable, contextual change the unit of collaboration. Every proposal carries intent, task context, evidence and dependencies. Reviewers approve a specific version, preview a compatible batch and publish one atomic update. Conflicts become explicit revisions that retain context and require fresh approval.

The design takes inspiration from Anthropic's account of Scion: keep clients light, read only the source needed for a task, share immutable data and move coordination to the server. Squali retains Git object and smart-HTTP compatibility. Agents do not need a clone or a working directory to submit an incremental change.

## How it uses Cloudflare (form draft)

Workers serves the interface and authenticated API. Artifacts is the canonical repository store. The Worker constructs valid incremental Git packs containing new blobs, affected trees and a commit, then sends them through Git smart HTTP with an expected-old-head check. Artifacts bindings handle sparse reads; immutable object caching avoids repeated provider calls. PostgreSQL through Hyperdrive stores intent, review state, dependency metadata, publication journals and a persistent operation budget. Publication uses a short per-workspace lock while unrelated proposals continue independently.

This separates cacheable immutable content from small mutable coordination records. It avoids a full clone per agent, batches publication, caps external attempts before dispatch and requires no per-agent Durable Object. Failed calls count toward the cap; there are no automatic paid retries or scheduled jobs.

## What the prototype demonstrates

- Parallel immutable proposals through a UI, HTTP API or CLI.
- Intent, context, evidence and dependency preservation.
- Review of exact versions with complete changed-file diffs.
- Independent edits reconciled in a batch; overlapping changes require a revision.
- Atomic Git publication, native clone/fetch and protection against external head movement.
- Durable recovery after a lost push acknowledgement; explicit cancellation before a push.
- Project-scoped roles, immutable caches and a persistent monthly operation cap.
- Desktop/mobile UI with bounded font loading and a usable network-failure fallback.

## Demo

[squali-demo.mp4](https://github.com/gridheap/squali/releases/download/v0.1.0/squali-demo.mp4) is a 6 minute 22 second English narrated walkthrough assembled from actual local application screens. It demonstrates the complete local workflow using real PostgreSQL and Git. It is edited, not a continuous screen recording or a cloud performance test. The narration script is [demo-script.json](demo-script.json).

## Reproduction

Follow [README](../README.md). Run `pnpm install`, `bash scripts/setup-local.sh`, then `pnpm dev`. The README supplies local fixture credentials, separate from production. Run `pnpm test:e2e` for the real HTTP/PostgreSQL/Git tests. Use `pnpm test:ui` with an installed browser for the rendered workflow. [Saved evidence](evidence/) includes commands, test output, browser font provenance and benchmark parameters.

## Performance evidence and limits

A local Apple M4 Max benchmark used 32 small changes, 8 concurrent clients and 64 baseline files. With immutable object caching it completed proposals in 555 ms (57.61 changes/s), with p95 proposal latency 179.18 ms, and published the batch in 479 ms. The batch pack was 2,347 bytes. The same fixture before caching took 1,222 ms and 743 ms respectively. The final design, which also moves Git I/O outside SQL transactions, recorded 917 ms for proposals (34.88 changes/s, p95 243.97 ms) in a later run on the shared machine. A slower run overlapping deployment work is retained as well. These are local measurements, not distributed-scale claims or a comparison with every competing platform.

The editing API accepts bounded UTF-8 regular files. Binary files, symlinks and submodules are preserved in unchanged trees but are not editable through this API. Evidence is agent-supplied. Squali does not execute CI or certify semantic correctness. An ambiguous publication followed by an external main advance requires administrator reconciliation. See the README for full limits.

## Deployment status

The application is deployed on Cloudflare Workers with real Artifacts and Azure PostgreSQL through Hyperdrive. A bounded cloud smoke test completed workspace creation, two agent proposals, reviewer approvals, compatible publication, sparse source reading, project/role authorization checks, native Git clone and `git fsck`. It reserved 79 conservative Artifacts calls across 23 HTTP attempts, including diagnosis, with no automatic retries. See [cloud-smoke.json](evidence/cloud-smoke.json).

The public endpoint is `https://squa.li`; Workers development and preview URLs are disabled. The read-only production browser verification passed with correct Adobe Latin and system CJK glyphs. Including this check, the application reserved 89 operations of its 2,000/month cap. The provider analytics snapshot observed 36 events, subject to ingestion lag and different event definitions; these counts are not billing totals.

The integration test used the original development hostname before the Squali brand and domain were selected. A separate read-only production browser check verifies the custom domain without repeating the successful cloud writes. Worker bindings authenticate to Artifacts directly; the REST credential's separate Artifacts permissions did not block deployment.

## Human submission

The official rules prohibit robotic, programmed or automated entries. An eligible team member must personally complete and submit the form after reviewing the materials:

- [Submission form](https://www.cloudflare.com/git-competition/submit/)
- [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
- Deadline: October 14, 2026 at 11:59 p.m. PDT, equivalent to October 15 at 14:59 in Taipei.

The team member must supply their own name, contact email, eligible residence and required confirmations. Upload the video and provide the repository/run instructions. Preparing these materials does not constitute a submitted entry.
