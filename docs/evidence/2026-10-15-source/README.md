# Source-service acceptance evidence

**Implementation acceptance passed; competition entry not submitted.** The fixed [20-item capability checklist](../../scion-acceptance.md) passes within its stated bounds, including all mandatory architecture items. This is not a percentage of Anthropic's unpublished implementation. [Readiness and explicit limits](../../readiness.md).

## Final checks

| Check | Exact command | Result |
|---|---|---|
| HTTP/CLI/native suite | `node --import tsx --test --test-concurrency=4 tests/*.test.ts` | [84/84 passed](imara-final-suite.txt) |
| Types | `pnpm typecheck` | [Passed](imara-final-typecheck.txt) |
| Worker build | `pnpm build` | [Passed](imara-final-build.txt) |
| Deployment | `pnpm deploy` | [79cc8779-a322-4f22-9219-4e563007e799](imara-final-deploy.txt), squa.li; previews disabled |
| UI/Adobe/brand | `WEAVE_UI_EVIDENCE=docs/evidence/2026-10-15-source/brand-ui pnpm test:ui` with `pnpm dev` | [5 passed](brand-ui-suite.txt), [runtime/screens](brand-ui/), [initial failure](brand-red.txt) |
| Linux FUSE | Exact commands in the retained JSON | [First read](fuse-green-attempt.json), [shared cache](fuse-green.json) |
| Private native verification | Exact command in the retained JSON; reusable script is `scripts/verify-import.py` | [Complete](private-verification.json), one clone, 40/48 HTTP attempts |
| Production browser | Repeatable UI sequence | [Steps and screenshots](private-browser-acceptance.md), [final brand](brand-production.png) |
| Native and provider accounting | Exact commands/query in retained JSON | [Native audit](native-final-audit.json), [provider response](provider-final.json), [reconciliation](../../cost-final.md) |
| Continuous recording | `SQUALI_DEMO_DIR=work/continuous-demo-final node --import tsx scripts/demo-continuous.ts` | [Capture log](continuous-final-recording.txt), [manifest and verification](demo-final/) |
| Capture validation | `node --import tsx scripts/check-demo-capture.ts work/continuous-demo-final` | 2,046 timed frames, all eight resulting views retained; [report](demo-final/capture-verification.json) |
| Encode / decode | `swift scripts/render-continuous.swift work/continuous-demo-final work/continuous-demo-final/squali-source-demo.mp4` | 410.2 s, 25,416,963 bytes; [report](demo-final/video-verification.json), five decoded frames |
| Audio decode | `swift scripts/inspect-demo-audio.swift work/continuous-demo-final work/continuous-demo-final/squali-source-demo.mp4` | [Audible in all eight scenes](demo-final/audio-verification.json) |
| Independent review | Read-only Standards and Spec axes | [Review record](review-snapshot.md), all earlier blockers corrected; final axes 0 new findings |

The API/CLI suite uses real PostgreSQL, HTTP and native Git with a persistent local adapter at the R2 boundary. Browser tests use installed Brave and isolated profiles. Provider acceptance is separately labeled. The latest cold Adobe activation took 5,375.5 ms; reviewer workflow readiness was 5,503 ms. CDP confirms Proxima Nova Latin and native PingFang SC CJK. Failure fallback/navigation reuse pass. Earlier slow and failed runs remain retained.

## Private import and honest scope

The frozen fixture contains **421,219 objects, 85,563 commits, 1,020 refs and 8,332,097,572 raw bytes**. All source objects and canonical deltas are durable. After eleven accepted seed batches, Artifacts returned its repository storage limit. The same cached pack became a [completed R2 compatibility snapshot](private-snapshot-complete.json); no fifth native attempt or second GitHub input clone was used.

Independent native fsck, full exported object/ref equality and inventory equality pass. Eight canonical changesets, root tree, README content/history/blame and graph relations independently match. A new proposal's canonical delta, file and tree pass, then the proposal is rejected; the published head stays unchanged. This is full exported-closure validation plus bounded source-semantic samples, not an exhaustive semantic test of all 85,563 commits.

The first verifier stopped on blame's resource estimate. A bounded comparator then exposed six incorrect blank-line origins. [Failure](private-verification-blame-failure.json), [native diagnostic](private-blame-v1-diagnostic.json) and intermediate reports remain retained. A later license check replaced the experimental LGPL module with the separately Apache-2.0 licensed imara-diff adaptation; the earlier LGPL source is not shipped. One additional blank-separator regression was recorded before correction.

The final module passes [135 native diff pairs and focused HTTP cases](imara-separator-green.txt) plus the complete 84-test suite. Only blame caches advance to v4. The [final live response projection](imara-production-blame.json) matches all 75 full commit origins and seven native original-line regression points; the exact offline command is in [the comparison report](imara-production-verification.json). [Screenshot](imara-production-blame.png), [single-request timing](imara-production-network.json), [provenance and complete validation](imara-validation.md). The original full native verification remains unchanged; this is supplemental validation of the replacement.

## Architecture and performance

- Canonical authority: `source.test.ts` in the final suite rebuilds native trees/commits after deleting compatibility metadata, preserving modes and non-UTF-8 commit bytes.
- Generic derived data: [index checks](derived-full-e2e.txt), [recursive blame](derived-blame-full-e2e.txt), eager/lazy rebuilding and explicit bounds.
- Graph: [merge-base failure](mainline-merge-base-red.txt), [ancestry failure](mainline-ancestry-red.txt), [native comparison](mainline-ancestry-green.txt); 1,024-step mainline queries use 13 SQL statements, with criss-cross and second-parent checks.
- SQL protocol/cache: [prepared statements](database-protocol-green.txt), [immutable cache](immutable-source-cache-green.txt), [production read sample](production-immutable-cache.json); repeated source-row queries fall from 11 to zero while scope checks remain live.
- Incremental operations: [proposal admission](proposal-admission-green.txt), [publication](publication-cost-green.txt), [watcher](working-copy-watch-green.txt), [base race](working-copy-watch-race-red.txt). The final watcher fixture remains bounded and reconciles OS-coalesced events.
- Local throughput: [64 changes / eight clients](local-source.json), 318.19/s, p95 95.93 ms. Production: [64-change baseline](cloud-baseline.json), [latest eight-change sample](cloud-prepared.json), 2.301/s, p95 3,368.85 ms. These different sizes are not a controlled speedup comparison.
- [Connection metrics](hyperdrive-performance.json) and [pool contention](hyperdrive-pool-contention.json) retain unfavorable results. The two-second proposal target remains unmet. [Performance and single-run private timings](../../performance.md).

## Retained recovery history

Earlier progress/failure reports are historical, not current pending work. [Chronology](chronology.md) preserves the original checkpoints.

- HTTP disconnect: [stopped journal](private-connection-stop.json), [real recovery fixture](changeset-disconnect-recovery.txt).
- Artifacts protocol/provider limits: [capability probe](artifacts-bridge-capabilities.json), [non-atomic recovery](native-nonatomic-green.txt), [provider failure](private-bridge-provider-error.json), [seed plan](private-seed-plan.json), [legacy counter check](native-seed-legacy-budget-red.txt), [attempt-limit E2E](native-recovery-budget-green.txt), [storage limit](private-seed-storage-limit.json).
- Snapshot: [budget](snapshot-budget.md), [native clone/fsck and HTTP cases](source-snapshot-final-e2e.txt), [wrong-membership/replay regression](source-snapshot-membership-red.txt), [one-click capacity fallback](native-snapshot-fallback-green.txt), [small-pack retention failure](native-snapshot-zero-limit-failure.txt), [installation](source-snapshot-install.json).
- Credential tracing isolation: [verifier](verification-tracing-green.txt), [native importer](native-clone-tracing-green.txt). Only fixture credentials occur in the corresponding red reports.
- First continuous recording: `continuous-demo-*` reports show an encoded movie, but visual inspection found stale frames after navigation. [Capture failure](continuous-capture-red.txt) is retained. **That movie is not the submission video.** [Corrected quick check](continuous-capture-quick.txt) and the `continuous-final-*` reports supersede it.

[Form text](../../entry-fields.md) and [submission material](../../submission.md) are ready for the eligible human entrant. No automated competition entry is sent.
