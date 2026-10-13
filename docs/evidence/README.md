# Verification evidence

- `api-e2e.txt`: `pnpm test:e2e`, 10 real HTTP/PostgreSQL/Git tests passed. Includes failure injection, native Git and authenticated clone/fetch.
- `browser.json`: `pnpm test:ui`, captured ready time, JavaScript errors and actual Latin/CJK font provenance. The browser suite also verifies a delayed/failed Adobe CSS request and navigation reuse.
- `benchmark-before-cache.json` and `benchmark.json`: `BENCH_CHANGES=32 BENCH_CONCURRENCY=8 pnpm benchmark`, same bounded local fixture before/after immutable caching.
- `video.json`: demo format, render command, duration, byte size and audio/video track counts. The narrated film uses actual local screenshots.

All application tests use local PostgreSQL and Git; no model APIs or live Artifacts load tests are involved. Test and benchmark output is environment-specific. Production Artifacts verification is pending the required Cloudflare permission, as recorded in `../submission.md`.

The final browser pass used `WEAVE_URL=http://127.0.0.1:8788 pnpm test:ui` against a fresh local server. `browser-e2e.txt` contains the complete result. New runs save their reports under the repository's ignored `work/` directory. `build.txt` records the production dry run with Artifacts and Hyperdrive bindings; a dry run does not prove deployed provider access.
