# Continuing the Scion implementation

October 15, 2026. Competition submission is paused at the user's request. No entry has been submitted. The v0.2.0 checklist is a historical feature inventory, not evidence that Squali reproduces 95% of Scion or its production results.

The reference remains [Anthropic's public design](https://www.anthropic.com/engineering/redesigning-source-control): online clients, server-side operations, immutable incremental changesets, recursively derived metadata, sparse/virtualized working copies, and strictly separated cache tiers. The implementation must be assessed through these behaviors and measured resource costs.

## Changes after v0.2.0

### Cold blame avoids repeated database work

A real HTTP test imports a native Git fixture containing 128 commits and 16 revisions of one file. It verifies every line's commit and original position against `git blame --root --line-porcelain`.

The original cold request issued **306 SQL statements**. The new request issues **79**, a 74.2% reduction. Graph statements fall from 112 to 9; path candidate queries from 32 to 1; source-object lookups from 78 to 32. These are local counts, not a claim about new production latency.

The changes reuse an immutable path-reader context per request, batch first-parent jump proofs, reuse indexed commit metadata, and resolve a parent's file at its latest relevant path event. Unchanged intermediate commits no longer create extra blame dependency aliases. Cache version 4 is preserved: no production cache invalidation or automatic backfill is needed.

The first 160-statement target passed after three changes. A separate failing test then established a 100-statement target before batched graph traversal was implemented. The final suite has **85 passing tests**. Merge-parent, edited-rename, newline, original-line and warm-replay checks remain in that suite.

### Writable virtual workspaces

The Linux client can now combine the immutable FUSE mount with a native OverlayFS upper layer in a fixed-size ext4 image. Ordinary filesystem reads hydrate source bodies on demand; ordinary writes stay local until an explicit proposal. The client submits only changed paths and does not move main.

Real Linux acceptance runs on the existing local Colima VM against the local HTTP source service. It covers edits, atomic replacement, additions, deletion, executable mode changes, restart, forced process death, exclusive mounting, base mismatch, disk exhaustion, background-process cleanup, lost proposal acknowledgements, immutable retry payloads and offline receipt replay. No new cloud resource or provider backfill is used. [Usage and limits](virtual-workspaces.md).

### Independent regional cache

The separate `squali-regional` Worker implements the same source RPC as the node and source tiers. It uses a source service binding, project-scoped immutable cache records, coalesced misses, short authorization deadlines, bounded admission, cooldowns and a source-outage circuit. Cache failure does not trigger an object-read bypass. Local HTTP evidence shows 16 concurrent readers sharing one source read; two actual node daemons and actual workerd also pass. [Architecture, bounds and evidence](regional-cache.md).

## Work still required

1. **Production latency:** stage timing and atomic sealing now reduce the same-client submission median from 1.833 to 1.488 seconds (four sequential samples per version). Sealing falls 384 → 84 ms. R2 PUT remains about 300 ms, first database access ranges 67–239 ms after deployment, and client/platform forwarding adds variable delay. Next isolate database setup and regional forwarding, and assess R2 placement without recreating storage or duplicating imports. Production p95/p99 and cold README blame (last 20.995 seconds) remain open. [Evidence](submission-latency.md).
2. **Regional capacity:** actual workerd now has a 512-blob working-set measurement, 16,384 additional cache-hit reads, process CPU/RSS and identified regional JS heap readings. Global/per-location scaling and long-duration behavior remain unmeasured. Objects larger than 1 MiB stream without regional retention. No 99% fleet hit rate has been established.
3. **Client completeness:** in-place dirty-workspace rebase now passes native Git and crash-recovery acceptance. It requires pausing the workspace command and Linux mount capability; arbitrary binary/symlink writes remain unsupported. Existing text/file limits still apply.
4. **Changeset cost at larger scale:** the 4,097-file/129-commit fixture now covers 768 writes at 8/32/128 concurrency, 12 publications, SQL counts, CPU, memory and storage calls. It recommends 32 concurrent bulk writers for the measured eight-connection pool. This single-host result does not establish horizontal scalability across regions or the best possible cost/performance.
5. **Production resources:** current scoped provider CPU, storage operations, reservations and prices are reconciled separately from local estimates. Production isolate memory, long-duration p95/p99 and a controlled infrastructure comparison with Git remain missing. Anthropic's 100 GB history, 25 million daily checkouts and 200-fold infrastructure reduction remain their results.

This checkpoint does not close the overall Scion goal. Do not replace these open items with a checklist percentage or competition-readiness claim.

## Evidence

[Saved commands and results](evidence/2026-10-15-scion-next/README.md). No new D1 or application Durable Object, external full import, quota increase, scheduled test or automatic backfill was introduced.

## Earlier deployment checkpoint

Worker `ba605dad-e0af-419d-afda-be13e901303f` was deployed on `squa.li` before the regional tier; Workers.dev and previews remained disabled. The production deployment succeeded with unchanged storage quotas and no asset uploads. The CLI probes returned 401 and 403. Subsequent verification through the existing signed-in production browser opened the private source workspace and returned HTTP 200 for README blame; all 75 line identities match the retained v4 result. The valid cache was reused, so no new cold-blame latency is claimed. [Deployment](evidence/2026-10-15-scion-next/deploy.txt) · [limited CLI smoke](evidence/2026-10-15-scion-next/production-smoke.json) · [authenticated browser verification](evidence/2026-10-15-scion-next/production-blame-verification.json).

## Regional deployment checkpoint

Source Worker `c81e2b62-86d2-403a-92b0-e83056b77c02` and regional Worker `c71c1cbb-4e09-418f-bfa9-e0f850862fe4` are deployed on the existing domain. **88 tests pass**, alongside actual workerd and Linux virtual-workspace acceptance through the new tier. Production verification observes a regional miss followed by a hit for a retained source object, exact content identity and successful project-API forwarding. Five HTTP attempts include one denied credential; no new access grant, import or automatic retry was used. [Current evidence](evidence/2026-10-15-regional/README.md). Competition submission remains paused.

## Rebase and capacity checkpoint

Source Worker `33af85df-5716-4900-a00a-239dbbb6525f` now serves the no-write workspace rebase planner on `squa.li`; the regional deployment remains unchanged. Five production calls pass, with no additional source read/write reservations. Real Linux tests compare the entire resulting tree with native Git and cover conflicts, cancellation, changed retry inputs and interruption on both sides of the atomic generation switch.

The longer local capacity run passes 128-client node reads, 16,384 regional cache reads, 65,536 node cache reads and 768 proposed/reviewed/published changes. It retains 130 earlier socket failures and their fixes. CPU, process RSS, regional heap, request latencies, exact object reads/writes and provider observations have separate records. [Measurements and limits](capacity.md) · [commands and raw evidence](evidence/2026-10-15-capacity/README.md). These results advance the public architecture match without inventing a percentage or submitting the competition.

## Incremental write checkpoint

Source deployment `fa64ef9e-9fcf-402d-ab21-17bd8d2becad` reduces a one-file proposal
from 32 to 24 SQL statements and fixes an admission failure in which an exhausted
write budget left an unstarted upload claim. **93 regression tests pass.** A
controlled local delayed-database comparison increases throughput by 34.8–39.2%
at 8/32 concurrency, with unchanged one-PUT-per-new-file behavior and exact native
Git export. The production fixture publishes eight changes using eight R2 writes,
one read and zero Artifacts calls. Its retained 35 attempts include eight scope
denials, one network failure and a read-only review reconciliation. Production
latency remains an open item. [Detailed assessment](write-path.md).

## Production stage-timing checkpoint

Source `7218bc81-1798-4158-95fa-06243110b4a8` adds opt-in request-local timing and a
two-statement sealing path for admitted single-parent changes. Recursive fallback,
canonical identity and the common versioned derivation rules are preserved. All
96 regression tests pass. Eight new production files are reviewed, published and
read back with 32 successful HTTP attempts and eight R2 writes/eight reads. No
Artifacts operation, quota change or repeated large import is needed. The measured
sealing improvement is 78%; client median improves 19%, while tail latency remains
unproven. [Measured stages, costs and limits](submission-latency.md).
