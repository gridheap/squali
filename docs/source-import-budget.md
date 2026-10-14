# Source migration admission budget

Prepared 2026-10-15 (Asia/Taipei), before production source-store dispatch.

The existing Azure Git cache is the input; no fresh GitHub clone or another full Worker-to-Artifact transfer is planned. Inspection found 421,219 unique Git objects: 85,563 commits (62,154,006 raw bytes), 166,297 blobs (5,680,908,242 raw bytes), 168,349 trees (2,588,270,349 raw bytes), and 1,010 annotated tags (764,975 raw bytes). The largest blob is 1,088,754 bytes. The existing Git pack is 324,579,659 bytes. Source fsck already passed for this frozen fixture.

Only blobs require individual durable R2 writes. Trees/commit records are derived SQL metadata; changesets are SQL log records. Expected unique R2 writes: **166,297**, plus a small separately identified acceptance fixture. Import preflight/missing checks, duplicate batches, metadata derivation and ref installation do not require R2 puts. There are no automatic retries. Ambiguous uploads are reconciled by immutable identity; successful earlier inputs must be reused.

Proposed dedicated source-store bounds (separate from existing cache/Artifacts counters): 200,000 write reservations/month, 200,000 read reservations/month, and 100 GiB logical bytes per repository. This import itself is admitted for at most 500,000 objects, 16 GiB uncompressed input, 12,000 HTTP attempts across all resumes, and one active importer. One invocation additionally has explicit batch/time ceilings. No quota or failed legacy import counter is reset.

Published R2 Standard prices checked on 2026-10-15: $0.015/GB-month, $4.50/million Class A, $0.36/million Class B, no egress charge. Included account-wide monthly usage is 10 GB-month, one million Class A and ten million Class B; remaining shared allowance is not yet known. Billing rounds upward to units. If no included allowance remains, the bounded source operations can add at most one Class A unit and one Class B unit ($4.86), plus storage. The uncompressed blob size bounds gzip storage to roughly 5.7 GB before provider rounding, or at most about $0.09/month at six GB-month. Existing PostgreSQL/VM capacity, Workers, database storage and Artifacts are separate. Logical byte admission is not a promise that 100 GiB will be allocated.

Before expanding a live pilot, record actual source reservation counters, accepted unique objects, uploaded compressed bytes and failures. Stop on unexpected duplication or budget growth. Retain the source objects and journal for resume; do not rerun all successful batches. No recurring source transfer is scheduled by this change.

Sources: https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/artifacts/platform/pricing/ (checked 2026-10-15). Provider-measured billing is distinct from application reservations.

## Fixed infrastructure and CPU boundary

Public retail rates checked again on October 15 are retained in `evidence/2026-10-15-source/azure-retail-prices.json`. In East US 2, the existing Linux F1as v7 VM lists $0.0683/hour and B1MS PostgreSQL compute lists $0.017/hour. At an illustrative 730 hours, compute alone is $49.86 + $12.41/month; 32 GB of PostgreSQL storage at $0.115/GB-month adds $3.68. VM disks, backups and network charges are separate. These are public list-price estimates, not the account's private invoice or Squali's marginal allocation. No VM or database SKU was enlarged for this work.

[Workers Standard](https://developers.cloudflare.com/workers/platform/pricing/) starts at $5/month, including 10 million requests and 30 million CPU milliseconds; excess rates are $0.30/million requests and $0.02/million CPU milliseconds. [Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/) is included in the paid plan. This one import's 12,000-attempt ceiling and 30,000 ms per-invocation CPU ceiling bound its Worker CPU to 360 million ms, at most $7.20 of CPU usage before included allowance. This deliberately pessimistic ceiling is not measured consumption and excludes unrelated API traffic. The final provider reconciliation remains required.

The existing shared Azure resources' actual billing was checked privately; public materials do not include the user's account billing records. List prices, application reservations, provider usage and incremental cost must remain distinct.
