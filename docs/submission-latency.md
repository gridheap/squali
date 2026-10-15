# Latest checkpoint

The subsequent [256-per-version tail experiment](tail-latency.md) supersedes this four-sample checkpoint for current routing, connection setup and measured p95/p99. The measurements below remain historical evidence.

# Production submission latency

October 15, 2026. Source version `7218bc81-1798-4158-95fa-06243110b4a8` is deployed
on [squa.li](https://squa.li). No competition entry has been submitted.

## Result

The measured bottleneck was serial PostgreSQL work while sealing a newly admitted
changeset. For a normal prepared single-parent edit, Squali now reads the complete
bounded dependency snapshot once and writes the canonical changeset, commit graph,
path events and versioned completion marker in one atomic statement. The generic
recursive path handles missing indexes, merges, imports and replays.

The shared derivation resolver, graph/path calculations and canonical identity
remain the same. The ancestor jump chain is read with a recursive SQL query bounded
to 32 records, rather than one network round trip per level. R2 uploads still finish
before sealing, and remain outside database transactions. Proposal visibility and
its audit event follow sealing. No database migration or additional service was needed.

A one-file edit in a 64-file local fixture falls from **24 to 14 SQL statements**.
A separate 18-level ancestry test stays at **13** statements per ordinary step;
the prior code required **23–27** as ancestry grew. The missing-index step is allowed
to use the bounded recursive fallback. Lazy reconstruction produces exactly the
same graph, jump pointers, path events and canonical identities. An injected marker
failure leaves none of the sealing effects visible; recovery does not repeat its PUT.

## Production comparison

Four sequential new edits per version use the same workstation, administrator
principal, frozen base, content length and project. All requests enter through LAX.
The instrumentation-only version is `108bfa49-79e9-491c-a548-551ea8f897d4`.
No sample was discarded or repeated. Medians are shown below; four samples do not
establish p95/p99 or sustained concurrency.

| Stage | Before median ms | After median ms |
| --- | ---: | ---: |
| First database access (connection setup + scope check) | 66.5 | 223.5 |
| Project metadata | 37.0 | 29.0 |
| Idempotency lookup | 35.0 | 35.0 |
| Base resolution and validation | 65.5 | 60.0 |
| Proposal journal admission | 37.5 | 35.5 |
| Git metadata construction | 35.5 | 23.5 |
| Object admission and budgets | 85.5 | 80.5 |
| R2 PUT batch | 300.5 | 302.5 |
| Durable blob readiness | 35.5 | 38.0 |
| Canonical changeset + graph/path sealing | 384.0 | 84.0 |
| Proposal/path/event finalization | 36.0 | 36.0 |
| Source Worker total | 1131.0 | 942.5 |
| Client response total | 1833.466 | 1487.756 |

Sealing falls **78.1%**, source Worker time **16.7%**, and client median
**18.9%**. Client ranges are **1,416–2,032 ms** before and **1,277–2,629 ms**
after. The slower after-sample spends 928 ms in the source Worker and about 1,701 ms
outside it. This is not evidence that tail latency improved.

R2 PUT remains roughly **300 ms**. First database access varies from 61–194 ms
before to 67–239 ms after. That span includes connection/type setup and the scope
query; it does not isolate PostgreSQL execution time. These are the next bottlenecks
to investigate with bounded probes. The current change directly reduces the measured
sealing work and does not attribute connection or network variation to that change.

## Timing interface and interpretation

Authenticated `POST /api/projects/:id/changes` requests can opt in with
`X-Squali-Timing: 1`. `Server-Timing` returns fixed stage names and elapsed durations.
No paths, content, credentials or SQL parameters are emitted, and no logging service,
extra database query or object-storage request is enabled. Concurrent traces are
request-local. Failed stages and idempotent replay are covered by HTTP tests.

`persist` includes admission, upload, readiness and sealing; `seal` includes its
read/write and graph/path children. These spans must not be added together. Worker
clock readings are I/O-oriented wall times, not CPU samples. Setup and authentication
read 0 ms in this fixture; it uses an existing static administrator credential and
therefore does not measure Clerk-session or interactive login latency.

## Verification and cost

All **96 regression tests** pass, plus typecheck and Worker build. Production uses
**32 HTTP attempts**, no errors/retries, and verifies all eight files after reviewed
publication. Main stays unchanged until publication. The final head is
`742170a5438c8fe5cfc675409fac3b4bdf2a4efd`. The fixture uses one administrator for proposal and review;
independent reviewer authorization is covered by the retained regression suite.

Source reservations increase by **8 writes and 8 reads**; Artifacts operations by
**0**. R2 operation value before shared allowances/rounding is **$0.00003888**.
There is no D1, application Durable Object, new recurring job, quota increase or
repeated large import. Artifacts remains the derived Git compatibility boundary;
R2 stores authoritative compressed file bodies and PostgreSQL stores metadata.

The production journal, provider observation, exact commands, every sample and all
failed development tests are retained in the [evidence](evidence/2026-10-15-submit-latency/README.md).
The completed measurement phases can be replayed offline. Scion fleet parity,
production p95/p99, provider peak memory and cold blame acceptance remain open.

## Provider observation

One scoped analytics query at **13:46:03 UTC** reports source PUT +8 and GET +7
since the retained 13:13 observation. Application reservations are +8/+8; the
adaptive provider view has not fully caught up. No extra query was dispatched to
force agreement. Month-to-date source CPU is 1,467,505.796 ms across 12,238 requests,
with the same two historical resource errors. Regional CPU is 65.854 ms across 75
requests. These totals include unrelated traffic and lag; they cannot establish
this change's CPU savings. [Reconciliation](evidence/2026-10-15-submit-latency/provider-comparison.json).

Project endpoints pass through the unchanged regional Worker service binding.
Client minus source Worker time includes that forwarding as well as the client
connection; the current instrument does not split those two components. Existing
storage snapshots lag further (13:00 UTC). No current storage-byte delta is claimed.
