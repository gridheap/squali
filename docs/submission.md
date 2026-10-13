# Competition submission material

## Project

**Weave — independent agent changes, one shared direction.**

Repository: https://github.com/gridheap/weave

License: MIT. The local application runs with PostgreSQL and Git; the production adapter targets Cloudflare Workers, Artifacts and Hyperdrive. No D1 or application Durable Objects are used.

## Vision (form draft)

AI agents can write code in parallel, but people still have to reconstruct why each edit exists, decide which changes belong together, and recover when a publication partially succeeds. Weave makes an immutable, contextual change the unit of collaboration. Every proposal carries intent, task context, evidence and dependencies. Reviewers approve a specific version, preview a compatible batch and publish one atomic update. Conflicts become explicit revisions that retain context and require fresh approval.

The design takes inspiration from Anthropic's account of Scion: keep clients light, read only the source needed for a task, share immutable data and move coordination to the server. Weave retains Git object and smart-HTTP compatibility. Agents do not need a clone or a working directory to submit an incremental change.

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

`weave-demo.mp4` is a 6 minute 13 second English narrated walkthrough assembled from actual local application screens. It demonstrates the complete local workflow using real PostgreSQL and Git. It is edited, not a continuous screen recording or a cloud performance test. The narration script is [demo-script.json](demo-script.json).

## Reproduction

Follow [README](../README.md). Run `pnpm install`, `bash scripts/setup-local.sh`, then `pnpm dev`. The README supplies local fixture credentials, separate from production. Run `pnpm test:e2e` for the real HTTP/PostgreSQL/Git tests. Use `pnpm test:ui` with an installed browser for the rendered workflow. [Saved evidence](evidence/) includes commands, test output, browser font provenance and benchmark parameters.

## Performance evidence and limits

A local Apple M4 Max benchmark used 32 small changes, 8 concurrent clients and 64 baseline files. With immutable object caching it completed proposals in 555 ms (57.61 changes/s), with p95 proposal latency 179.18 ms, and published the batch in 479 ms. The batch pack was 2,347 bytes. The same fixture before caching took 1,222 ms and 743 ms respectively. These are local measurements, not distributed-scale claims or a comparison with every competing platform.

The editing API accepts bounded UTF-8 regular files. Binary files, symlinks and submodules are preserved in unchanged trees but are not editable through this API. Evidence is agent-supplied. Weave does not execute CI or certify semantic correctness. An ambiguous publication followed by an external main advance requires administrator reconciliation. See the README for full limits.

## Deployment status

The Azure PostgreSQL database, dedicated role/schema, outbound private connector and Weave Hyperdrive configuration are provisioned. The production Artifacts adapter is implemented and typechecked. The current Cloudflare credential still returns `Authentication error` for Artifacts; production deployment and the real Artifacts end-to-end smoke test remain pending that permission. Local evidence must not be represented as proof of the cloud integration.

## Human submission

The official rules prohibit robotic, programmed or automated entries. An eligible team member must personally complete and submit the form after reviewing the materials:

- [Submission form](https://www.cloudflare.com/git-competition/submit/)
- [Official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf)
- Deadline: October 14, 2026 at 11:59 p.m. PDT, equivalent to October 15 at 14:59 in Taipei.

The team member must supply their own name, contact email, eligible residence and required confirmations. Upload the video and provide the repository/run instructions. Review the final cloud deployment status before making claims in the form. Preparing these materials does not constitute a submitted entry.
