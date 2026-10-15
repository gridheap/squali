# Bounded tail latency experiment

User request: isolate R2 upload, first database connection and regional forwarding;
reduce measured production p95/p99 while preserving Scion's immutable source model.
No competition submission, repeated import, new database or Durable Object.

## Measurement plan and hard bounds

- Same local workstation, existing administrator fixture credential, project
  `source-acceptance-20261015`, frozen base, content size and concurrency.
- Two phases of 256 distinct one-file proposals, concurrency 8. Each begins with
  an eight-request pilot. Extending the pilot reuses its saved successes.
- At most 640 HTTP attempts across phases, pilots, verification and explicit
  recovery; at most three attempts per immutable input; no automatic retry.
- Save every dispatched attempt, including failures and ambiguous outcomes.
  First attempts remain in statistics; a fast replay never replaces a slow or
  failed original. No discarded warmup or tail samples. Abort new dispatch on failure.
- Empirical nearest-rank p95/p99 and maximum, plus failure count and every stage.
  With n=256, p99 is the third-largest observation. This is not a fleet SLO.
- Publish eight evenly sampled proposals and read back every selected file.
  All remaining accepted benchmark proposals stay as fixture drafts.
- One end-of-run provider observation; preserve lag rather than poll for agreement.

## Pricing and usage evidence

Official pricing checked October 15, 2026:

- https://developers.cloudflare.com/r2/pricing/: Standard $4.50/million Class A,
  $0.36/million Class B, $0.015/GB-month, shared allowances and unit rounding.
- https://developers.cloudflare.com/workers/platform/pricing/: $0.30/million
  excess requests and $0.02/million excess CPU-ms, plus existing base plan.
- https://developers.cloudflare.com/r2/buckets/local-uploads/: no extra fee for
  Local Uploads; standard Class A costs and strong consistency remain.

The retained 13:46 UTC provider report is
`../2026-10-15-submit-latency/provider-current.json`. Its application checkpoint
leaves 33,481 source writes and 199,771 reads under the unchanged monthly caps.
Normal planned storage work is 512 PUTs and about eight verification GETs:
$0.00230688 unrounded operation value. A conservative 640 PUT / 5,120 GET envelope
is $0.0047232. At two Workers, 640 requests and the existing 30,000 ms CPU ceiling,
the conservative excess CPU envelope is $0.768, not an invoice or billing cap.
Included allowances, PostgreSQL/shared infrastructure and base fees are separate.

## Baseline and changes under test

Instrumentation baseline source: `0a5c615e-bdae-458a-b375-bec01a8c5772`.
Regional timing deployment: `0e8fad09-be63-498c-b6cf-ec1e183f953c`.

`r2-before.json` confirms WNAM, default jurisdiction, Local Uploads disabled.
A Wrangler info call failed before this observation; two direct, bounded metadata
reads succeeded. No objects were transferred by those configuration checks.

Before optimizing, measure connection startup by reserving/releasing a driver
connection without a probe query, and regional forwarding around its source
service binding. Keep the existing prepared-statement protocol.

Proposed optimizations, contingent on tests: reuse bounded, disposable driver type
codecs across fresh request clients; enable R2 Local Uploads after the baseline;
avoid an unnecessary regional hop for writes only if measured evidence supports it.
Storage semantics, authentication, main/ref publication and cache-tier failure
rules must remain intact.

## Execution adjustments and retained outcomes

The eight-request optimized pilot had one TLS EOF. One explicit same-ID recovery
completed it without another blob reservation. The first optimized draft was read
back before expansion. Four route checks shared the existing 640-attempt ceiling.
Final totals: 544 HTTP attempts, 512 unique proposals, 512 source write reservations,
9 read reservations and zero Artifacts operations. No additional full phase ran.

The cache implementation saves completed native codecs at client shutdown, with
a four-key/512-codec/five-minute bound. Startup timing uses the first real query
dispatch; reserve is unsafe as the first operation with discovery disabled in
Postgres.js 3.4.9. The scope span therefore includes startup after optimization.
The final provider query was rejected with rate-limit budget depletion. No quota
change or repeat query followed. See the full report for evidence limitations.
