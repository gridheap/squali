# Acceptance and entry readiness

> **Superseded status, October 15:** competition submission is paused at the user's request. No entry has been submitted. The release checklist below describes v0.2.0 within its original bounds; it does not establish 95% Scion equivalence or overall goal completion. See [continued implementation and open gaps](scion-next.md).

**Implementation acceptance passed; the project package is ready for the eligible team member. No competition entry has been submitted.** The Apache-2.0 comparator replacement passes the final local suite and the live private-file regression. The eligible team member must personally submit under the official rules.

## What passed

- **20/20 fixed capability criteria**, including mandatory architecture items 3, 4, 5, 6, 13 and 15. This clears the project's ≥19/20 threshold. It measures the [published completion criteria](scion-acceptance.md), not the percentage of Anthropic's unpublished implementation or a competition score.
- **84/84 HTTP, CLI and native tests**, five rendered browser tests, typecheck and Worker build. Tests cover canonical changesets, independent R2 blobs, CAS publication, derived data, graph/path queries, rebase/revert/bisect, permissions, semantic review, sparse clients, cache isolation, import recovery and Git interoperability. [Evidence index](evidence/2026-10-15-source/README.md).
- **Large private import:** 421,219 frozen objects, 85,563 commits, 1,020 refs and 8.33 GB raw history. All exported objects and refs match native Git; fsck passes. Eight canonical deltas, root tree, README content/history/blame and graph queries independently match. A rejected write smoke verifies a new delta without changing the published head. One verification clone and 40/48 HTTP attempts. [Result](evidence/2026-10-15-source/private-verification.json).
- **Production Clerk/GitHub and UI:** real sign-in, 97 authorized repositories, completed private workspace, source/history/blame, rejected proposal and cost view. The final five-shark logo and `squa.li` wordmark render in production and at 320–1440 px. Adobe Latin/system CJK and bounded fallback pass. [Browser proof](evidence/2026-10-15-source/private-browser-acceptance.md).
- **Cost reconciliation:** provider measurements, application reservations, original failures, shared Azure capacity and ongoing storage are documented. The queue has no pending/running jobs; acceptance credentials are revoked; no recurring verification or full backfill is scheduled. [Report](cost-final.md).
- **Current continuous video:** 410.2 seconds, 25,416,963 bytes, H.264/AAC, one video/audio track. All eight scenes have audible narration; 2,046 retained timed frames; five decoded frames inspected, including the final production report. [Media evidence](evidence/2026-10-15-source/demo-final/) and [reproduction](demo-source.md).
- **Final comparator validation:** 135 native line-diff pairs pass. The live v4 response matches all 75 full commit origins and seven retained native original-line regression points. [Replacement evidence](evidence/2026-10-15-source/imara-validation.md).
- **Independent review:** final Standards and Spec reviews each found zero new actionable findings. Earlier findings and their fixes remain documented in [the review record](evidence/2026-10-15-source/review-snapshot.md).

## Production and measured limits

Worker `79cc8779-a322-4f22-9219-4e563007e799` serves https://squa.li. The legacy workers.dev and preview URLs remain disabled. No D1 or application Durable Object. Source data persists; disposable cache expires after seven days.

Artifacts reached its repository limit after eleven accepted seed batches. The same retained native pack now provides a verified R2 Git snapshot; no fifth native attempt, second GitHub clone or repeated source backfill was used. Snapshot admission remains 500,000 objects, a 512 MiB pack and a 16 MiB index.

The latest bounded production sample achieves 2.301 proposals/s, p50 1.486 s, p95 3.369 s and eight-change publication in 1.825 s. The two-second proposal investigation target is **unmet**. The original private README blame sample took 17.378 s; the final Apache/v4 request took 20.995 s, excluding Clerk refresh. These separate observations do not establish a speedup. These are transparent observations, not a highest-performance claim. [Performance](performance.md).

Linux FUSE is read-only; edits use the writable sparse client/API. PostgreSQL has not demonstrated Spanner-scale horizontal throughput. There is no dedicated regional cache fleet, measured 99% fleet hit rate, full-text code search or automatic CI. Text, graph, rename and export budgets remain explicit. [Capability boundaries](scion-parity.md).

## Final human step

The [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) prohibit automated entries. An eligible team member must personally review the [prepared form text](entry-fields.md), provide their contact/eligibility confirmations, upload the accepted video and submit the [official form](https://www.cloudflare.com/git-competition/submit/).

Deadline: **October 15, 2026 at 14:59 Taipei**, equivalent to October 14 at 11:59 p.m. PDT. Publishing the GitHub release is not a competition entry.
