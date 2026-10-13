# Verification evidence

- `api-e2e.txt`: `pnpm test:e2e`, 11 real HTTP/PostgreSQL/Git tests passed. Includes failure injection, native Git and authenticated clone/fetch.
- `browser.json`: `pnpm test:ui`, captured ready time, JavaScript errors and actual Latin/CJK font provenance. The browser suite also verifies a delayed/failed Adobe CSS request and navigation reuse.
- `benchmark-before-cache.json` and `benchmark.json`: `BENCH_CHANGES=32 BENCH_CONCURRENCY=8 pnpm benchmark`, same bounded local fixture before/after immutable caching.
- `video.json`: demo format, render command, duration, byte size and audio/video track counts. The narrated film uses actual local screenshots.

The automated regression suite and benchmarks use local PostgreSQL and Git. No model APIs or live Artifacts load tests are involved. Separately, `cloud-smoke.json` records the bounded real-cloud integration test, including native Git clone and fsck. Test and benchmark output is environment-specific.

The final browser pass used `WEAVE_URL=http://127.0.0.1:8788 pnpm test:ui` against a fresh local server. The final transaction refactor was rechecked with `WEAVE_URL=http://127.0.0.1:8789 pnpm test:ui`. `browser-e2e.txt` contains the complete result. New runs save their reports under the repository's ignored `work/` directory. `build.txt` records the production dry run with Artifacts and Hyperdrive bindings; a dry run does not prove deployed provider access.

`benchmark-short-transactions.json` records the final transaction design: 34.88 changes/s, p95 243.97 ms in a serial benchmark run. `benchmark-short-transactions-build-overlap.json` records a slower run overlapping deployment build work. All measurements are retained; the current Squali video quotes the final serial run, not a guaranteed latency.

The final branding pass used `SQUALI_URL=http://127.0.0.1:8789 pnpm test:ui`. `production-browser.json` records a read-only check on the final public domain. `domain-routing.json` records the custom domain and disabled Workers development/preview hostnames. `artifacts-analytics.json` records the provider analytics snapshot, which may have ingestion lag and is not an invoice.

`placement.json` records six metadata-only HTTP observations around the Azure East US 2 placement configuration. The request budget remained 89; no Artifacts operations were added.

The original cloud commands were run from the delivery workspace. Portable copies are included as `scripts/cloud-smoke.py` and `scripts/check-placement.py`; they read a private access JSON path through `SQUALI_ACCESS_FILE`. The cloud smoke mutates its `demo` fixture, preserves checkpoints and has a 40-HTTP-attempt / 250-provider-reservation ceiling. Do not rerun a completed live workflow solely for a presentation change. The placement script reads metadata only.
