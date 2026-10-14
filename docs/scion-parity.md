# Squali and the Scion design

Source: [Anthropic, Redesigning source control](https://www.anthropic.com/engineering/redesigning-source-control), October 13, 2026. Updated October 14.

The objective is an online source-control service for agents. GitHub import is one entry point. This table distinguishes implemented behavior from Scion's larger architecture and measured scale. **Full Scion parity has not been achieved; final competition submission remains premature.**

| Article capability | Implemented in Squali | Remaining gap |
|---|---|---|
| Online clients; optional working copy | Authenticated source, metadata and change APIs; lightweight CLI | CLI does not replace every Git command |
| Cheap immutable changesets | Incremental blobs, changed ancestor trees and commits; durable proposal identity and intent | Git proposal refs retain reachability; unlike Scion, changesets are not independent of Git's object/ref model |
| Server-side reconciliation | Three-way merges, immutable revisions, dependency ordering, reviewed subset publication | Semantic compatibility still requires review/testing |
| History, blame, ancestry, merge bases, diff, revert, bisect | Server APIs, versioned SQL-derived answers, first-parent history pagination; reviewed revert | Versioned generation/skip indexes and bounded resumable builds now support larger graphs; hash-verified bulk metadata avoids per-commit provider reads. General traversal has a 50,000-node budget; arbitrary path history/blame still need fuller indexes. Bisect does not execute tests |
| Extensible derived data | Immutable versioned derived records; repeated blame needs no provider reads | Bounded graph indexing can resume explicitly; no general background derivation/backfill service |
| Tiered immutable caching | Shared CLI disk cache → Worker isolate/edge → private R2 → Artifacts; quotas and R2 outage admission | No node socket daemon, regional cache fleet or refreshed cache snapshots; no measured 99% per-tier hit rate |
| Sparse/virtualized checkout | Materialize requested paths, explicitly hydrate more; reuse cached objects; large binary reads | Explicit add, server-commit base advancement, and journaled clean-copy update are implemented and process-death tested. No OS filesystem mount; symlinks/submodules still require native Git. One writer per working copy |
| Repository/directory IAM | Clerk owner isolation; expiring/revocable role and directory credentials; blocked escape routes | Local cache is not an OS security boundary between mutually untrusted processes sharing one user account |
| Semantic approval constraints | Path policies require independent reviewers and agent-supplied evidence; policy changes invalidate approval | No parser-backed comment-only classification or trusted CI attestation |
| Review, search and selected landing | Context, revisions, dependencies, conflicts, selected approved changes; path search with bounded API cursors; file history/blame UI | Recent change/publication windows; search/history UI needs pagination. No full-text code index |
| Failure recovery | Git CAS, deterministic SQL journal, real process-death tests; independent import reconciliation | External head movement after ambiguous publication needs explicit reconciliation |
| Large existing repository | Created a private Git mirror with 85,563 commits, 1,020 refs, 324,579,659 packed bytes; fsck passed | Production Artifacts transfer has not completed within three attempts. No claim of successful large import |
| Independent scaling | Stateless Workers, immutable objects, per-workspace publication coordination | No demonstrated fleet-scale load, 100 GB repository, or universal performance/value result |

## Responsibilities and limits

- **Workers:** authentication, path policy, bounded queries, incremental writes and request admission. No full repository checkout or pack decompression in the Worker.
- **Artifacts:** authoritative Git objects/refs, compare-and-swap publication and native Git interoperability. Current **1 GB repository / 32 MB object** limits remain hard backend constraints.
- **R2:** private, rebuildable immutable object cache. Entries up to 1 MiB expire after seven days. Durable SQL claims deduplicate writes. Larger raw objects bypass this tier. No public bucket or credentials in cache objects.
- **PostgreSQL through Hyperdrive:** identities, journals, review policy, derived metadata and usage reservations. No D1 or application Durable Objects.
- **CLI:** sparse files and a shared 64 MiB disk cache. Authorizes before reuse, validates blob identity and prevents overwriting local edits. Directory credentials use authorized path traversal rather than whole-repository object access.

Scion reports 100 GB history, a 25 GB working copy, 25 million daily checkouts, over 99% cache hits per tier, 200× smaller infrastructure and about 100× faster checkout. These are **Anthropic's measurements**. R2 caching cannot remove Artifacts' repository limit. Supporting that size requires an authoritative sharded object store and Git bridge, which Squali does not yet implement.

See [readiness](readiness.md), [performance](performance.md), [API](api.md), [working copy](working-copy.md) and [evidence](evidence/2026-10-14-scion/).
