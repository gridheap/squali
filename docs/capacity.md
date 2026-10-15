# Rebase, capacity and resource measurements

October 15, 2026. Competition submission remains paused. These results extend the [Scion implementation](scion-next.md); they do not establish a percentage equivalence to Anthropic's internal system.

## Workspace rebase

The same Linux workspace can now move to an immutable target while preserving local text edits, additions, deletions and executable modes. The server computes the three-way merge without creating staging commits. The client stages a bounded new overlay, verifies it, unmounts and fsyncs it, then atomically switches the manifest. Conflict, cancellation, lost HTTP response and process interruption preserve recoverable state. The workspace command must be stopped during this operation; this is not a live switch underneath running processes.

Real Linux acceptance compares the complete merged tree with native Git cherry-pick. The rebase itself fetches **zero client file bodies**. It leaves main unchanged. A separate explicit proposal creates the changed source objects. [Usage and recovery](virtual-workspaces.md) · [result](evidence/2026-10-15-capacity/virtual-rebase-result.json).

The source API is deployed as Worker `33af85df-5716-4900-a00a-239dbbb6525f`. The five-call production check passed with an exact result, unchanged main and zero additional source read/write reservations. The plan request took **1,306.08 ms** from this client. This is one network-inclusive observation, not a production latency percentile.

## Reproducible local capacity

The main workload uses an Apple M4 Max, 16 logical CPUs, 128 GiB RAM, Node 24.21.0 and an isolated PostgreSQL 17.11 cluster. Source SQL uses eight connections. The regional tier runs actual Cloudflare workerd, service bindings and Cache API. Eight actual Python daemon processes each have a 32 MiB cache. The source R2 adapter is local persistent disk.

Fixture: **4,097 files, 129 commits, 67,092,480 baseline bytes**, 4,674 imported Git objects. The warm working set is 512 unique blobs / 8,386,560 bytes. Content is deliberately deterministic and compressible; it is not the private 8.33 GB import. That separate import's native fsck and complete object/ref comparison remain valid and were not repeated.

```sh
python3 scripts/capacity-run.py \
  --output work/capacity-result --sustained
```

The runner creates and stops its own local PostgreSQL, workerd and node processes. It has a 900-second whole-run ceiling, finite operation counts and no cloud service access. A completed output directory is reused without executing again; an interrupted directory is preserved. Use the pinned Node runtime on `PATH`. PostgreSQL currently uses the documented local installation path in the runner.

### Longer workload result

All requests below completed without errors or automatic retries. Latency includes queueing at the configured concurrency. These are finite runs, not an endurance or multi-region test.

| Phase | Clients | Attempts | Successful operations/s | p95 ms | Source object calls | R2-adapter GET / PUT |
|---|---:|---:|---:|---:|---:|---:|
| New node, new regional store | 8 | 512 | 421.09 | 22.15 | 512 | 512 / 0 |
| Seven new nodes, populated region | 8 | 3,584 | 1,256.48 | 10.23 | 0 | 0 / 0 |
| Populated nodes, initial burst | 128 | 8,192 | 20,622.60 | 12.18 | 0 | 0 / 0 |
| Populated region, longer read phase | 8 | 16,384 | 1,305.14 | 12.18 | 0 | 0 / 0 |
| Populated nodes, longer read phase | 128 | 65,536 | 17,857.59 | 17.84 | 0 | 0 / 0 |
| Independent proposals | 8 | 256 | 589.80 | 18.39 | — | 0 / 256 |
| Independent proposals | 32 | 256 | 739.78 | 50.04 | — | 0 / 256 |
| Independent proposals | 128 | 256 | 789.92 | 183.21 | — | 0 / 256 |
| Reviews | 8 | 768 | 1,688.83 | 6.89 | — | 0 / 0 |
| Publications of 64 changes | 1 | 12 | 87.46 | 12.88 | — | 0 / 0 |

The longer regional and node phases last **12.55 s** and **3.67 s**, respectively. All 768 proposed files were reviewed, published and verified. Each proposal writes one new blob; publications create **zero additional blob PUTs**. Each proposal issued approximately 38 SQL statements on this wider fixture.

**Use 32 concurrent writers for bulk work on the measured eight-connection setup.** Going from 32 to 128 gains about 6.8% throughput while making p95 latency 3.66 times higher. Eight writers give lower latency. This is a recommendation for this workload and pool, not a global server limit.

The first 128-client burst exposed 19 dropped connections; a subsequent bounded-wait revision exposed 111 kernel-backlog refusals. Both failed runs are retained. The final admission design keeps 32 active threads, at most one accept-loop waiter and a 128-connection kernel backlog. Sustained overload returns an explicit 503 or kernel connection refusal; no origin bypass or hidden retry is added.

[Full result](evidence/2026-10-15-capacity/sustained-measured/result.json) · [earlier passing bounded run](evidence/2026-10-15-capacity/full-bounded-backlog/result.json) · [all commands and failed runs](evidence/2026-10-15-capacity/README.md).

## CPU and memory

The longer complete run took **25.93 seconds wall time**. OS child-process accounting recorded **29.73 user + 37.62 system = 67.35 CPU seconds**, including setup, importer, load generator, PostgreSQL, node daemons, workerd and the process sampler. This is local host CPU, not Cloudflare-billed CPU. Node-only per-phase CPU values include the load generator and are labelled accordingly in the report.

The highest sampled sum of process RSS was **3.04 GiB**. The earlier shorter passing run reached 2.04 GiB. Both sums include the test driver and runtimes, and can double-count shared PostgreSQL pages. The sampler waits at least 100 ms between `ps` calls; timestamps retain the actual sampling intervals. Short phase CPU attribution can cross a sample boundary. Neither sampled RSS nor a post-phase heap reading is an exact peak of a production isolate.

The inspector records the loaded `regional-worker.js` identity. Before the longer region phase, its JS heap used **37.04 MiB**; afterward it used **16.59 MiB**, with **53.75 MiB allocated JS heap**, **22.91 MiB backing storage** and **2.78 MiB embedder heap** reported separately. No forced garbage collection was requested. These readings demonstrate bounded live heap for this test; they do not explain every byte of the workerd process RSS or prove a production memory ceiling.

[Process measurements](evidence/2026-10-15-capacity/sustained-measured/resources.json) · [raw samples](evidence/2026-10-15-capacity/sustained-measured/resource-samples.json) · [regional heap observations](evidence/2026-10-15-capacity/sustained-measured/heaps.json).

### Node CPU optimization after the full run

The whole-system tables above were captured after the backlog fix and before the subsequent fixed-thread optimization. Their measurements remain unchanged. A separate controlled Unix-socket test then compared the same **32,768 verified 16 KiB cache hits at 64 concurrent clients**, with one prefill and no further object reads upstream.

| Node implementation | Node CPU ms | Requests/s | Peak node RSS | Errors |
|---|---:|---:|---:|---:|
| New thread per request | 7,060.28 | 6,688.45 | 36.02 MiB | 0 |
| 32 reusable worker threads | 5,622.80 | 7,358.94 | 36.36 MiB | 0 |

This observation reduces measured daemon CPU **20.36%** and increases throughput **10.02%**, with approximately unchanged memory and p95 latency. CPU comes directly from the daemon's OS resource accounting, excluding the load generator. The comparison is one controlled local workload, not a confidence interval or a fleet-wide claim. A second pre-change run failed the written 20% CPU-reduction target; the first fixed-worker run passed it. The fixed pool retains bounded admission, backlog and failure isolation.

[Baseline](evidence/2026-10-15-capacity/node-cpu-baseline.json) · [pre-change failing target](evidence/2026-10-15-capacity/node-cpu-red.json) · [fixed-worker result](evidence/2026-10-15-capacity/node-cpu-fixed.json). Exact invocations are recorded in each result. The final 89-test regression and Linux checks also run against the fixed-worker implementation.

## Storage calls and cost

Local capacity runs made **zero external provider calls**. The final local workload measured 512 source GETs and 768 proposal PUTs after fixture setup. At published R2 Standard excess rates, those operations have a prorated value of **$0.00364032**, excluding fixture ingestion, Workers, PostgreSQL, account allowances and billing-unit rounding. This is a projection from measured adapter calls, not money charged for the local test. The complete fixture/run measured 4,992 PUTs and 512 GETs, about $0.02265 at those prorated operation rates.

Production verification made five application HTTP requests and **no new source PUTs or GET reservations**. The first provider analytics attempt was rejected with 401 because the retained session had expired; one explicit recovery using current Wrangler authentication succeeded. Both attempts remain recorded. No full repository import, cache purge, quota increase or recurring workload was introduced.

### Provider observation through 11:39:46 UTC

| Measurement | Observed value | Interpretation |
|---|---:|---|
| Source Worker invocations | 12,170 | Month to date, including two historical resource-limit errors |
| Source Worker CPU | 1,464,637.903 ms | Provider `cpuTimeUs` divided by 1,000 |
| Regional Worker invocations / CPU | 9 / 18.545 ms | Month to date; successful |
| Source R2 PUT / GET | 166,179 / 213 | Provider operation observations, including older work |
| Source payload / objects | 2,192,995,260 bytes / 166,502 | Latest storage point, 11:00 UTC; not GB-month billing |
| Application source reservations | 166,503 writes / 220 reads | Conservative admitted attempts, not provider billing |
| Remaining monthly source reservation allowance | 33,497 writes / 199,780 reads | Existing 200,000 caps remain unchanged |
| Artifacts reservations | 345 / 2,000 | No new Artifacts ingestion |

Compared with the earlier 03:54 checkpoint, source observations increased by 52 invocations, 3,265.8 CPU ms and five GETs; provider PUT count is unchanged. This interval includes other Squali checks and cannot be attributed solely to this rebase rollout. The 324-write gap between application reservations and provider PUTs remains visible; adaptive reporting and admitted unsuccessful work are not silently equated with an invoice.

At the Workers excess CPU rate of $0.02/million CPU ms, the source month's observed CPU has an illustrative value of **$0.02929**, before allowances. Do not sum service-binding invocation counts as separately billed requests. The account-wide $5 Workers plan, R2 billing units, Artifacts storage and shared Azure compute remain separate. Existing Azure VM plus PostgreSQL/storage list-rate exposure remains approximately **$65.95/month**, before the exclusions in the [cost reconciliation](cost-final.md). No new cloud resource was provisioned for these measurements.

[Provider query and response](evidence/2026-10-15-capacity/provider-current.json) · [production plan and reservations](evidence/2026-10-15-capacity/production-rebase.json). Current prices and the retained October 15 official-source checks are linked in [cost-final.md](cost-final.md).

## What this establishes, and what remains

- The public Scion design's server-side merge, incremental changed-byte writes, shared node cache and strict regional/source separation have concrete local acceptance evidence. The same workspace can now advance through a recoverable generation switch.
- Cache-hit phases eliminate source calls. The whole workload includes cold fills; it does not establish a 99% hit rate at every tier in a real fleet.
- Large private import correctness is covered by the retained 421,219-object audit. This capacity fixture covers width/concurrency separately; it does not reproduce 100 GB of history or 25 million daily checkouts.
- Cross-region saturation, long-duration production p95/p99, provider memory high-water data and a controlled Git/Scion infrastructure comparison remain unmeasured. The client still restricts source writes to bounded UTF-8 regular files and requires pausing its workspace command during rebase.

These are material limits. No “95% Scion” or “200× smaller” claim is supported, and competition submission remains paused at the user's direction.
