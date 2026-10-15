# Squali 0.2 — source service and verified private import

Live: https://squa.li · [Run locally](https://github.com/gridheap/squali#run-locally) · [Acceptance](https://github.com/gridheap/squali/blob/v0.2.0/docs/readiness.md)

Agents create immutable, incremental source changes without a clone or proposal refs. Reviewers approve exact revisions, resolve conflicts and publish a selected set with a separate CAS update. Workers, authoritative R2 blobs, PostgreSQL through Hyperdrive and Artifacts provide the service; no D1 or application Durable Objects.

## Accepted in this release

- 20/20 fixed capability criteria against the public Scion design, with all six mandatory architecture gates. This is the project's bounded checklist, not Anthropic certification or a claim to reproduce its unpublished implementation.
- A private copy of Git history: 421,219 objects, 85,563 commits and 1,020 refs. Full exported object/ref equality and native fsck pass. Eight canonical deltas, README history/blame, root tree and graph queries independently match native Git.
- R2 Git snapshots preserve native clone/fetch for admitted repositories after Artifacts explicitly reaches its storage limit, reusing the existing input and cumulative budgets.
- 84 API/CLI/native tests, five browser tests, typecheck/build, actual Linux FUSE and production Clerk/GitHub acceptance. [Evidence](https://github.com/gridheap/squali/tree/v0.2.0/docs/evidence/2026-10-15-source).
- Five-shark logo, `squa.li` wordmark and desktop/mobile typography checks.

## Attached demonstration

`squali-source-demo.mp4`: 410.2 seconds, 25,416,963 bytes, H.264/AAC. Continuous local source-service workflow with three independent agent identities, review, selected publication, conflicts, blame, semantic policy and cost controls, ending with retained production verification. No cuts or scene retiming. Eight narrated scenes and decoded video frames are verified. It is not a cloud performance benchmark.

## Measured boundaries

Latest bounded cloud sample: 2.301 proposals/s, p95 3.369 s and eight-change publication 1.825 s. The two-second proposal target remains unmet; the original private-file blame sample took 17.378 s and the final Apache/v4 sample took 20.995 s. FUSE is read-only; writes use the sparse client/API. Graph, text and export operations have finite budgets. No Spanner-scale, 99% fleet cache hit rate or fastest-system claim. [Performance](https://github.com/gridheap/squali/blob/v0.2.0/docs/performance.md) · [Costs](https://github.com/gridheap/squali/blob/v0.2.0/docs/cost-final.md).

The final Apache comparator additionally passes 135 native diff pairs and a live check of all 75 README commit origins plus seven native original-line regression points. This supplement follows the continuous recording.

Original Squali code is MIT. The bounded imara-diff adaptation is Apache-2.0; its source, license, attribution and modifications are included.

This release is the prepared project package. An eligible team member must personally submit the competition entry under its official rules.
