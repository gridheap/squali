# Original goal and submission readiness

Status: **not ready for final submission**. This supersedes any earlier suggestion that deployment and submission materials alone meant the original request was complete. The user requested a complete agent collaboration product informed by Anthropic's source-control design, with strong performance and cost efficiency, without D1.

The competition requires Workers, Artifacts, concurrent agent changes, an open-source license, a 5–10 minute video and runnable instructions. Its judging weights are originality/prototype quality (50%), concurrency/coordination/context/review/conflicts (25%), and usability (25%). Meeting the delivery format alone is insufficient.

## Acceptance gaps identified by inspecting the implementation

| Area | Existing evidence | Missing acceptance evidence / behavior |
|---|---|---|
| Data model and Git compatibility | Immutable proposal records, context, sparse reads, incremental packs, native clone/fsck | Clerk/GitHub import and scoped agent credentials now pass local acceptance. Production OAuth remains pending; bulk sparse reads/local working-copy cache and complete lineage navigation remain open |
| Correctness | 12 API E2E tests, publication SIGKILL recovery, GitHub import SIGKILL recovery | Post-acceptance publication termination is fixed and tested; a pre-acceptance termination can still leave `metrics.active` forever; cancellation vs delayed external push needs a safe contract; retry must remain deterministic across reviewer identities |
| Review UI | Local two-change workflow | Multi-file retention and mode/deletion controls are implemented; the two-file revision browser test passes. Selecting publication subsets still needs implementation/acceptance |
| Cost UI | Published list prices and server-side operation cap | The page now reads actual conservative reservations. Per-workflow cost and a complete deployment cost model remain unmeasured |
| Concurrency | 32 local small proposals, eight clients | Sustained bounded mixed read/write workload, high contention, duplicate requests, many changes, repeated publication/recovery and bounded client backpressure |
| Scaling | Cached immutable objects, short SQL locks | Fresh default bases and zero-provider proposal replay are fixed and tested; unpaginated 200-change/100-history views; global operation-counter contention unmeasured |
| Performance/value | Local throughput and six cloud metadata reads | Same-workload native Git baseline, bytes/CPU/memory, cold/warm behavior, p95/p99 under contention, incremental cost per successful change |
| Product readiness | Custom domain; legacy tokens; Clerk/import code under acceptance | Normal TLS/HTTP access now succeeds. Clerk production GitHub credentials and backend secret remain pending. Local browser import/agent-credential flows pass; the real OAuth/import walkthrough remains unverified |
| Demonstration | Edited narrated screenshots | Continuous capture of the improved workflow, failure/recovery, real coordination and measured comparisons |

## Changes verified after this audit

- Multi-file revisions preserve all files; the cost page shows actual reserved usage.
- Default proposal bases follow Git, and completed proposal replays make no provider calls.
- Publication recovery after Git acceptance passes a real process-kill test. The pre-acceptance/cancellation gaps above remain.
- Clerk owner isolation, private GitHub imports, all-page selection, full reachable history/heads/tags, default branches, empty-repository first publication, resumable imports, and scoped/revocable agent credentials pass local API/browser/native-Git tests. Production OAuth is not yet configured.
- The old claim that public DNS/TLS still fails is superseded by a normal-route TLS-verified HTTP 200 observation.

## Work order

1. Fix data-loss and correctness problems with failing HTTP/browser E2E tests first.
2. Complete the multi-file review and real-usage workflows, then verify the public entry points.
3. Prove crash/retry behavior using actual process termination; avoid automatic lease expiry that could let an old writer act after cancellation.
4. Complete existing-repository/agent workflows and bounded list/read interfaces.
5. Run a bounded local performance matrix and honest native Git comparison. Use existing cloud evidence for unchanged behavior; new live checks must have explicit operation ceilings.
6. Update the public deployment and demo only after the corresponding acceptance checks pass.

No full cloud load test or provider quota increase is authorized by this document. A universal “highest performance” claim cannot be established by one implementation's measurements; identify the workload and publish comparative evidence instead.

## Sources

- https://www.anthropic.com/engineering/redesigning-source-control
- https://www.cloudflare.com/git-competition/
- https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf
