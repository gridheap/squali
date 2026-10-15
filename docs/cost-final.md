# Acceptance cost reconciliation

Checkpoint: **2026-10-15 03:54 UTC**. The large private import and independent verification are complete. These are scoped usage observations and public-price estimates, not an account invoice. The later brand deployment and a few browser reads occur after this checkpoint; no further import or cloud load test was dispatched.

## Measured work

The frozen private input has **421,219 objects**, **85,563 commits**, **1,020 refs** and **8,332,097,572 raw bytes**. Its 166,297 unique blobs were ingested once, with durable identity checks and reuse on resume. One later rejected write-verification proposal adds one blob, tree and commit without changing the published head. Final SQL inventory therefore contains 421,222 objects and 85,564 canonical changesets.

[The native audit](evidence/2026-10-15-source/native-final-audit.json) records 9,602 / 12,000 source HTTP attempts, 20,882 / 28,800 seconds of cumulative native execution and 4 / 4 historical job attempts. The historical failures remain counted. Native input occupies 381,100,338 bytes; the PostgreSQL schema occupies 2,911,854,592 bytes.

After eleven accepted Artifacts seed batches, Artifacts returned its repository storage limit. Dispatch to Artifacts stopped. The same cached pack became an R2 compatibility snapshot: 41 ready chunks, 336,374,863 bytes (324,579,659-byte pack plus 11,795,204-byte index), one upload attempt, 183.089 seconds and zero chunk retries. No fifth native attempt or new GitHub clone was used. Source blobs have one recorded retry in total. Complete successful snapshot replay performs no repeat PUTs.

Independent acceptance used **40 / 48 HTTP attempts and one verification clone**. It compares every exported object and ref and runs native fsck. Eight canonical deltas and one file's history/blame are explicitly bounded semantic samples. It retains failed responses and reuses completed calls; it does not restart the budget or clone on resume. See [the exact result](evidence/2026-10-15-source/private-verification.json).

## Provider observations and application reservations

[Provider query and complete response](evidence/2026-10-15-source/provider-final.json) cover October 1 through the checkpoint. The query is scoped to Squali's two buckets, Worker and dedicated Artifacts namespace. It includes earlier failures and manual checks.

| Service | Provider observation | Application reservations / interpretation |
|---|---|---|
| Source R2 | 166,179 successful PUTs; 208 successful GETs | 166,503 writes / 200,000; 215 reads / 200,000 |
| Source storage | 166,501 objects; 2,192,995,206 payload bytes + 18,916,976 metadata bytes, latest point 03:00 UTC | Native source blobs compress to 1,856,605,100 bytes after the write smoke; snapshot adds 336,374,863 bytes |
| Disposable R2 cache | 9 successful PUTs; 10 failed/missing GETs; 1,638 payload bytes at 03:40 UTC | 20 writes / 2,000; 32 reads / 20,000 |
| Workers | 12,118 requests, including 2 resource-limit errors; 1,461,372,103 CPU microseconds; 1,707 subrequests | CPU equals 1,461,372.103 milliseconds. These are the month's scoped observations, not just the final successful attempt |
| Artifacts | 111 action events + 2 error events; includes 13 pushes, 2 pulls, 44 reads, 2 creates, 48 token creates and 2 revocations | 345 / 2,000 admitted operations; provider event types and application reservation units differ |

The 324-write difference between source reservations and provider PUT observations is retained. Admission occurs before calls; failures, reuse and adaptive-reporting lag can make these counters differ. The evidence does not attribute every difference to a specific cause. Do not convert either number into an exact invoice or a measured cache hit rate. HeadBucket/lifecycle and setup operations are retained in the raw provider report as well.

## Price estimates and ongoing exposure

Prices checked October 15; account-wide included allowances and discounts are unknown.

- [R2 Standard](https://developers.cloudflare.com/r2/pricing/): $0.015/GB-month, $4.50/million Class A operations, $0.36/million Class B. About 2.2 GB of retained source payload represents roughly **$0.033/month before rounding**, or $0.045 at three GB-month. Around 166,000 writes represent $0.75 on a prorated calculation; billing rounds to units and shares an account allowance, so this is not the charged amount. The original conservative $4.86 operation allowance covers one Class A and one Class B billing unit if none of the shared free allowance remains.
- [Workers Standard](https://developers.cloudflare.com/workers/platform/pricing/): $5/month base, including 10 million requests and 30 million CPU ms; excess $0.30/million requests and $0.02/million CPU ms. Measured scoped usage has an illustrative excess-rate value of about **$0.033**, excluding base, rounding and included allowance. The base remains shared infrastructure exposure. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/) is included in the paid plan.
- [Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/): published storage/operation allowances and rates apply. At $0.50/GB-month above the storage allowance and $0.15/1,000 operations above the operation allowance, these small scoped counts do not establish an incremental charge because account totals and final Artifacts storage bytes are unknown. The failed compatibility copy still occupies storage; its provider limit bounds it, and it was not silently deleted.
- Existing Azure East US 2 VM: F1as v7 $0.0683/hour. PostgreSQL B1MS: $0.017/hour plus 32 GB at $0.115/GB-month. At 730 hours this is **$65.95/month for shared compute and PostgreSQL storage**, before VM disks, backups, network, discounts or taxes. Native runtime allocation is about $0.396 at the VM list rate; it is not an extra bill if the existing VM was already running. [Retained retail prices](evidence/2026-10-15-source/azure-retail-prices.json).
- Azure outbound data can incur charges after the shared allowance. [Retained bandwidth prices](evidence/2026-10-15-source/azure-bandwidth-prices.json) show $0.087/GB in the applicable standard tier; repeated historical failed bridge bytes are not erased from the accounting. The final exact account bill remains outside this public report.

No SKU, provider quota, monthly operation cap or source budget was enlarged for the final snapshot/verification. R2 source data persists; disposable cache expires after seven days. The native service is idle and notification-driven (one task, about 18.7 MB at audit). The queue contains **one complete job and no pending, running or failed jobs**. Acceptance credentials were revoked. There is no recurring acceptance run, automatic failed-job restart or duplicate full transfer queued. Normal user-triggered work remains subject to the existing caps.

## Work after the accounting checkpoint

The brand and Apache comparator deployments, targeted production file/blame reads and the final v4 response occurred after 03:54 UTC. One upstream GraphQL blame read and two successful GitHub connector reads supplied the pinned regression inputs; subsequent comparisons run offline. Failed local GitHub/Azure HTTPS connections are retained as failures. One existing Azure diagnostic command was updated with a 180-second ceiling and a read-only cached-metadata query; its result was unavailable and is not counted as a passing verification. No source import, clone, quota increase or recurring probe was added. The provider totals above were not refreshed, so they do not include this small validation/publication supplement.

## October 15 rebase/capacity checkpoint

The later [capacity and cost report](capacity.md#storage-calls-and-cost) refreshes product-scoped provider observations through 11:39:46 UTC and preserves this earlier checkpoint for comparison. The new local load tests have zero provider calls; five production rebase-verification requests add no source read/write reservations. No cloud resource, quota increase, new import or recurring load job was created. Current source read/write reservations are 220 / 166,503 against the unchanged 200,000 limits. The report separates measured provider CPU, local process CPU/RSS, actual adapter calls and price projections.
