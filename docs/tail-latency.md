# Production submission tails

October 15, 2026. Deployed on [squa.li](https://squa.li). **Competition submission
remains paused.** This checkpoint improves a bounded production workload; it does
not establish 95% Scion parity or complete production acceptance.

## Measured result

Same workstation, credential, project, frozen base, one-file payload size and
concurrency **8**. **256 distinct proposals per version**, with no discarded
warmup or slow requests. Percentiles use nearest rank; p99 is the third-largest
of 256 observations.

| Stage | Before p50 | After p50 | Before p95 | After p95 | Before p99 | After p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Client first-attempt outcome | 1,872 ms | 1,488 ms | 3,175 ms | 2,613 ms | 4,694 ms | 3,108 ms |
| Source Worker | 1,250 ms | 998 ms | 2,106 ms | 1,708 ms | 2,574 ms | 1,935 ms |
| R2 PUT batch | 310 ms | 234 ms | 492 ms | 360 ms | 696 ms | 471 ms |
| First database connection | 50.5 ms | 4 ms | 164 ms | 38 ms | 268 ms | 173 ms |

Client p95 falls **17.7%**, p99 **33.8%**; source p99 falls **24.8%**.
R2 p99 falls **32.3%**, connection p99 **35.4%**. These are observed phase
differences for three changes tested together, not isolated causal estimates.
Client maximum falls from 6,776 to 5,488 ms; the latter is a failed TLS attempt.

Before: 256 successful first attempts. After: 255 successful first attempts and
**one `SSLEOFError`** (0.39%). Its original 5,488 ms remains in client statistics;
one explicit same-ID recovery succeeds. Server-stage statistics have 255 samples
afterward because the failed TLS request returned no stage headers. The client
statistic measures the first attempt's outcome, not successful completion including
manual recovery time. Every attempt and recovery is retained.

## Changes

### R2 uploads

The existing authoritative `squali-source` bucket is **WNAM**, Standard, default
jurisdiction. Enabled **Local Uploads** on that bucket and verified the setting.
No bucket replacement, object migration, import replay or duplicate authoritative
store was needed. According to [Cloudflare's documentation](https://developers.cloudflare.com/r2/buckets/local-uploads/),
the feature writes nearby and replicates to the home region while preserving
immediate access and strong consistency; it has no extra operation fee. It is a
beta feature, and immediate reads near the home bucket can incur cross-region
latency before replication finishes.

The first optimized draft was read back before expanding the pilot. The same
admission-before-PUT, durable-readiness and immutable changeset ordering remains.
At **234 ms median**, upload latency is still substantial. This experiment does
not show how much of the remaining delay is R2 metadata coordination or transport.

### First database connection

Each request retains its own Postgres.js client and socket. Prepared statements
stay enabled. A bounded isolate cache reuses the driver's native type codecs,
including PostgreSQL arrays, avoiding repeated catalog discovery on warm isolates.
The cache holds at most **four database/session keys**, **512 parser and serializer
entries per key**, and expires entries after **five minutes**. It stores no query
promise or active connection. Custom connection/type/transform options fall back
to ordinary discovery. Schema/type changes can require expiration or a new deploy.

Codecs are saved after client shutdown, when native discovery has completed.
Request debug/notice callbacks are detached before retaining the native codec
registry. Oversized catalogs are not cached. The shared local development database
contains about 97,000 codec entries from retained test schemas; the new acceptance
therefore uses a disposable local database and removes it afterward. That test
runs **27 fresh HTTP database sessions with one catalog query**, preserving escaped
array paths, ordered dependencies, transactions and nine publication parents.

A real workerd test covers fresh source clients, local R2, four proposals,
publication, service bindings and both RPC URLs. It caught and prevented a driver
initialization hang: Postgres.js 3.4.9 can leave an initial `reserve()` unresolved
when discovery is disabled. Production now uses the first real query to open the
connection and closes its timing span at driver dispatch, without a probe query.

**Timing caveat:** baseline startup was measured by reserve/release before the
scope query. Optimized startup is measured until the first query is dispatched;
its enclosing scope/auth span includes startup. Do not compare raw scope spans or
sum nested stages. Both timings exclude the first business query's response wait.
Workers' clocks measure I/O-oriented wall time, not CPU.

### Regional routing

The regional Worker now owns `/api/regional/*`. Updated node daemons send both
authorization and object reads to `/api/regional/projects/:id/rpc`. Ordinary
project writes reach the source Worker directly, preserving their existing URLs.
The source retains placement near Azure East US 2.

Older `/api/projects/:id/rpc` clients still pass through the regional service
binding. Its return hop uses the named `SourceRpc` entrypoint with normal source
authorization, avoiding a forwarding loop. Updated nodes reach the edge cache
directly; older clients retain an extra source hop. No cache-failure bypass is
introduced. See [ordered migration](regional-cache.md#current-deployment-order).

Baseline regional-minus-source time was p50 **209 ms**, p95 **304 ms**, p99
**364 ms**. It includes cross-region transport, so removing this Worker invocation
does **not** prove that the full interval was eliminated. Successful client-minus-
source p99 falls from 3,288 to 2,068 ms, but also includes connection/network
variation. Production verifies a new-route miss/hit, legacy object read and legacy
head read. The new-route warm read is 324 ms, a single observation, not a percentile.

## Acceptance and cost

- **98 regression tests pass**, plus real source/regional workerd acceptance,
  typecheck and Worker build. The later pilot-read runner change passes its targeted
  HTTP/CLI test. Tests use local resources; no repeated large import or clone.
- **512 distinct immutable proposals** accepted. Main stays unchanged until
  publication. Eight evenly sampled proposals are reviewed, published and every
  selected file read back. The other 504 fixture changes remain proposed.
- Final head: `e1a3ffee5de10a1a33463bdf5acb0f73ebcc41bc`.
- **544 HTTP attempts** under the persistent 640-attempt ceiling; one explicit
  recovery, zero automatic application retries. Pilot extension and completed
  phase replay reuse saved successes.
- Application reservations: **512 source writes, 9 source reads, 0 Artifacts**.
  No duplicated blob writes were reserved for the TLS recovery. Remaining source
  caps: **32,969 writes and 199,762 reads** this UTC month.
- Unrounded R2 operation value at Standard rates: **$0.00230724** before shared
  allowances and billing rounding. This is calculated from reservations, not a bill.
  SQL/shared infrastructure, storage duration and base plan costs are separate.
- The one final Cloudflare analytics request was rejected with **“Rate limiter
  budget depleted”**. The response is retained; no automatic polling or quota
  increase followed. Current provider operation/CPU reconciliation is unavailable.
  The retained prior provider observation is from 13:46 UTC; it is not relabeled
  as a new CPU result. No new claim about CPU savings or provider memory is made.
- No D1, application Durable Object, new database service, increased pool/quota,
  recurring job, automatic backfill or scheduled benchmark was added.

Source deployment: `30ffa419-b45a-48ac-9922-50c957a28f17`.
Regional deployment: `a1789d85-bc0a-4e27-98c5-f83b73432984`.
Workers.dev and preview URLs remain disabled.

## What remains

R2 PUT and serial PostgreSQL work still dominate source time. Source p99 is nearly
two seconds; client/network tails remain larger and one connection failed. Next
work should consolidate the measured scope/project/base/journal round trips while
preserving authorization and immutable admission, and separate origin-pool queue
wait from SQL execution before changing capacity. Do not increase connections or
migrate storage on the strength of this sample alone.

This result is from one client location, one small-file workload and one principal,
not a cross-region soak, fleet SLO or Clerk-login benchmark. Cold README blame is
still last measured at 20.995 seconds. Provider peak memory, Scion's fleet hit rate,
arbitrary binary/symlink editing and a controlled Git infrastructure comparison
remain open. Scion's immutable source model and strict read tiers remain the design
reference; its fleet-scale performance is not established by this test.

[Exact commands, all samples, failures and deployment evidence](evidence/2026-10-15-tail-latency/README.md).
