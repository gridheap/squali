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

1. **Production latency:** the retained proposal p95 is 3.369 seconds and final cold README blame observation is 20.995 seconds. The SQL reduction has local evidence; production improvement still needs a bounded, controlled observation using new or genuinely missing results. Do not delete valid caches to manufacture a benchmark.
2. **Regional capacity:** the independent tier and failure tests now exist. Global/per-location scaling behavior, a representative cache working set and CPU/memory usage still need measurement. Regional objects larger than 1 MiB currently stream without being retained. No 99% fleet hit rate has been measured.
3. **Client completeness:** the writable overlay needs Linux mount capability, pins one base and currently submits regular UTF-8 text within existing API limits. It does not yet provide an in-place rebase/update of a dirty virtual mount or arbitrary binary/symlink source writes. A new state directory can use the returned proposal commit and reuse the same node cache.
4. **Changeset cost at larger scale:** validate changed-byte cost, SQL admission contention and tree/compatibility derivation on wider repositories. The retained eight-client sample is insufficient to establish horizontal scalability or best cost/performance.
5. **Representative capacity and cost:** use finite, reproducible workloads and separately report CPU, memory, storage operations, cache hit rates, latency and failed attempts. Anthropic's 100 GB history, 25 million daily checkouts and 200-fold infrastructure reduction remain their results.

This checkpoint does not close the overall Scion goal. Do not replace these open items with a checklist percentage or competition-readiness claim.

## Evidence

[Saved commands and results](evidence/2026-10-15-scion-next/README.md). No new D1 or application Durable Object, external full import, quota increase, scheduled test or automatic backfill was introduced.

## Earlier deployment checkpoint

Worker `ba605dad-e0af-419d-afda-be13e901303f` was deployed on `squa.li` before the regional tier; Workers.dev and previews remained disabled. The production deployment succeeded with unchanged storage quotas and no asset uploads. The CLI probes returned 401 and 403. Subsequent verification through the existing signed-in production browser opened the private source workspace and returned HTTP 200 for README blame; all 75 line identities match the retained v4 result. The valid cache was reused, so no new cold-blame latency is claimed. [Deployment](evidence/2026-10-15-scion-next/deploy.txt) · [limited CLI smoke](evidence/2026-10-15-scion-next/production-smoke.json) · [authenticated browser verification](evidence/2026-10-15-scion-next/production-blame-verification.json).

## Current deployment checkpoint

Source Worker `c81e2b62-86d2-403a-92b0-e83056b77c02` and regional Worker `c71c1cbb-4e09-418f-bfa9-e0f850862fe4` are deployed on the existing domain. **88 tests pass**, alongside actual workerd and Linux virtual-workspace acceptance through the new tier. Production verification observes a regional miss followed by a hit for a retained source object, exact content identity and successful project-API forwarding. Five HTTP attempts include one denied credential; no new access grant, import or automatic retry was used. [Current evidence](evidence/2026-10-15-regional/README.md). Competition submission remains paused.
