# Incremental source write cost

October 15, 2026. This checkpoint addresses Scion's requirement that small
changesets be cheap to create. It does not establish full Scion parity or
competition readiness. No competition entry is submitted.

## Changes

Proposal visibility, changed-path records and the audit event now commit in one
PostgreSQL statement. Its conditional update chooses one winner under concurrent
retries. If any effect fails, all three roll back. Blob acceptance and canonical
changeset sealing still finish before the proposal becomes visible.

Source object admission now combines immutable blob claims, project byte usage
and monthly write reservations in one database round trip inside a short
transaction. Either budget can reject the entire admission before an R2 request.
Previously, a denied write reservation could leave an uploading claim even
though no PUT had started; an explicit retry then encountered an active lease.
The transaction fixes that failure and reduces network round trips. R2 uploads
remain outside database transactions. Unknown upload outcomes still require the
existing bounded identity/metadata reconciliation.

R2 remains authoritative for individually compressed, content-addressed file
contents. A new one-file edit needs one PUT and no unchanged-file GET. Artifacts
continues to provide the derived Git compatibility repository; it is not called
for each unpublished source proposal. This retains cheap independent changesets
and standard Git interoperability without adding D1 or application Durable Objects.

## Local results

The isolated HTTP regression changes one file in a 64-file repository. Its SQL
statement count falls from **32 to 24 (25%)**, including transaction statements.
The complete suite has **93 passing tests**. Additional cases cover rejected byte
and operation budgets, eight callers competing for three reservations, an audit
write failure, and eight simultaneous retries producing exactly one event and
one source blob PUT. Existing import, canonical identity and recovery tests remain.

A controlled comparison uses the baseline source at commit `0e86020` and the
current source, the same real PostgreSQL pool of eight connections, filesystem
R2 adapter, and HTTP entry point. A local TCP proxy delays each direction by
10 ms per chunk. Each version submits 8 changes at concurrency 1, then 64 at 8
and 64 at 32. Both versions publish eight reviewed changes and verify the native
Git clone's head, file contents and `git fsck --full`.

| Concurrency | Before requests/s | After requests/s | Before p95 ms | After p95 ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1.26 | 1.74 | 1,085.05 | 715.84 |
| 8 | 8.79 | 11.85 | 1,957.16 | 1,475.02 |
| 32 | 12.34 | 17.17 | 2,685.63 | 2,031.11 |

All 272 proposed changes succeed. Every new proposal uses one source PUT,
zero source GETs and zero Artifacts calls. The different path shape in this
benchmark uses approximately 31 SQL statements before and 23 after; initial
connection setup adds seven statements to the eight-client phase.

This is a **synthetic database-link experiment**, not production latency or a
distributed fleet test. Node CPU includes the source server, HTTP load generator
and delay proxy, and excludes PostgreSQL CPU. Peak Node RSS was about 459 MiB
before and 513 MiB after; no memory reduction is established. There is only one
controlled comparison, without a statistical confidence interval. These results
do not replace the retained production latency observations.

## Bounded production verification plan

Use the existing `source-acceptance-20261015` fixture and the existing
`cloud-acceptance.py --follow-up --series atomic` runner once after deployment.
Eight new tiny text changes, eight reviews, one publication and verification
require 25 HTTP requests on success. Its persisted journal allows at most 40
total attempts and three attempts per unique input; there is no automatic retry.
Completed evidence is reused offline. Do not repeat the original import, clone,
or successful earlier workload. Do not change cloud quotas or create resources.

Expected new storage work is eight R2 PUTs, about one verification GET and zero
Artifacts operations. A conservative recovery allowance is 24 PUTs and 128 GETs
within the same attempt journal, subject to the existing application limits.
The pre-run usage response provides current remaining reservations.

Official prices checked October 15:

- [R2 Standard](https://developers.cloudflare.com/r2/pricing/): $4.50/million
  Class A, $0.36/million Class B, $0.015/GB-month; shared allowances and rounding
  affect the invoice.
- [Workers](https://developers.cloudflare.com/workers/platform/pricing/): excess
  requests $0.30/million and CPU $0.02/million ms. At 40 requests, conservatively
  counting two Worker executions each at the configured 30-second CPU cap gives
  $0.048 of illustrative excess CPU value. Including the storage allowance above
  remains below $0.05 before rounding, existing fixed costs and taxes. This is
  an estimate, not a provider-enforced dollar ceiling.
- [Artifacts](https://developers.cloudflare.com/artifacts/platform/pricing/):
  excess operations $0.15/1,000 and storage $0.50/GB-month. This smoke test requires
  no new Git compatibility export and admits no Artifacts operations.

No recurring job, scheduled load or automatic backfill is enabled.

## Production outcome

Source Worker `fa64ef9e-9fcf-402d-ab21-17bd8d2becad` deployed successfully on
`squa.li`; existing R2, Artifacts, Hyperdrive and regional bindings are unchanged.
Workers.dev and previews remain disabled. No schema migration is required.

The eight-change smoke completes in **35 total HTTP attempts**, within its
40-attempt bound. The first eight writes received 403 because the old agent
credential did not cover this fixture. Recovery used the existing administrator
credential for the same unchanged inputs; no principal's permissions were
expanded. One review then encountered an SSL EOF. A single read of the change
list confirmed that review was still pending, so only that review and the missing
following steps were resumed. No successful source write was repeated.

All eight files are published and the final content check passes. Source
reservations increase by **8 writes and 1 read**; Artifacts reservations increase
by **0**. Remaining source allowance is **33,489 writes and 199,779 reads**.
Illustrative R2 operation value is $0.00003636 before shared allowances and
billing-unit rounding; it is not an invoice.

Observed proposal p95 is **4,531.073 ms**, throughput **1.762 changes/s**, and
publication **2,121.203 ms**. This workstation-based sample uses an administrator
principal; the earlier 3,368.849 ms sample used an Azure-hosted client and a
different principal. It is not a controlled production speedup/regression test,
nor an independent-review demonstration. Production latency remains unsatisfactory
and needs stage-level timing before further tuning. No extra successful workload
was run to obtain a better number.

A single scoped provider analytics query at **13:13:57 UTC** succeeds. Source R2
PUT observations increase from 166,179 to 166,187 and GETs from 213 to 214 relative
to the previous 11:39 observation, matching the application's eight writes and
one read. Current month-to-date source Worker CPU is 1,466,086.639 ms across
12,208 invocations; the regional Worker records 40.051 ms across 39 invocations.
These adaptive totals include historical work and may lag. They are not CPU
measurements attributable solely to this eight-change run. Storage reporting
still reflects the 12:50 snapshot, before the new writes.

## Evidence

[Commands and retained results](evidence/2026-10-15-write-path/README.md).
