# Source migration admission budget

Prepared 2026-10-15 (Asia/Taipei), before production source-store dispatch.

The existing Azure Git cache is the input; no fresh GitHub clone or another full Worker-to-Artifact transfer is planned. Inspection found 421,219 unique Git objects: 85,563 commits (62,154,006 raw bytes), 166,297 blobs (5,680,908,242 raw bytes), 168,349 trees (2,588,270,349 raw bytes), and 1,010 annotated tags (764,975 raw bytes). The largest blob is 1,088,754 bytes. The existing Git pack is 324,579,659 bytes. Source fsck already passed for this frozen fixture.

Only blobs require individual durable R2 writes. Trees/commit records are derived SQL metadata; changesets are SQL log records. Expected unique R2 writes: **166,297**, plus a small separately identified acceptance fixture. Import preflight/missing checks, duplicate batches, metadata derivation and ref installation do not require R2 puts. There are no automatic retries. Ambiguous uploads are reconciled by immutable identity; successful earlier inputs must be reused.

Proposed dedicated source-store bounds (separate from existing cache/Artifacts counters): 200,000 write reservations/month, 200,000 read reservations/month, and 100 GiB logical bytes per repository. This import itself is admitted for at most 500,000 objects, 16 GiB uncompressed input, 12,000 HTTP attempts across all resumes, and one active importer. One invocation additionally has explicit batch/time ceilings. No quota or failed legacy import counter is reset.

Published R2 Standard prices checked on 2026-10-15: $0.015/GB-month, $4.50/million Class A, $0.36/million Class B, no egress charge. Included account-wide monthly usage is 10 GB-month, one million Class A and ten million Class B; remaining shared allowance is not yet known. Billing rounds upward to units. If no included allowance remains, the bounded source operations can add at most one Class A unit and one Class B unit ($4.86), plus storage. The uncompressed blob size bounds gzip storage to roughly 5.7 GB before provider rounding, or at most about $0.09/month at six GB-month. Existing PostgreSQL/VM capacity, Workers, database storage and Artifacts are separate. Logical byte admission is not a promise that 100 GiB will be allocated.

Before expanding a live pilot, record actual source reservation counters, accepted unique objects, uploaded compressed bytes and failures. Stop on unexpected duplication or budget growth. Retain the source objects and journal for resume; do not rerun all successful batches. No recurring source transfer is scheduled by this change.

Sources: https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/artifacts/platform/pricing/ (checked 2026-10-15). Provider-measured billing is distinct from application reservations.
