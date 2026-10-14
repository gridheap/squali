# Source architecture acceptance, 2026-10-15

This is intermediate evidence. The fixed Scion checklist and the full private import are not yet complete; the competition has not been submitted.

## Reproducible commands

- `node --import tsx --test tests/source.test.ts`: HTTP/native Git authority, resumable import, binary transport, interrupted writes, canonical rebuild, raw RPC, regional cache, eager graph, path history, legacy encoding and historic tree modes. Individual red/green transcripts are retained here.
- `node --import tsx --test tests/node-cache.test.ts`: real Unix socket daemon, 12 concurrent clients, one source read, snapshot restore, credential separation and failed-read cooldown.
- `node --import tsx --test --test-concurrency=4 tests/*.test.ts`: `full-api-e2e.txt` records 48 passing tests at that checkpoint. `final-api-checkpoint.txt` records the newer complete suite: 57 passed.
- Linux: `SQUALI_PROJECT=scion-source-pilot python3 tests/fuse-e2e.py --work /var/tmp/squali-fuse-acceptance`. `fuse-green-attempt.json` contains the first cold two-mount content pass (2,275 ms, two content objects), which also exposed an xattr warning. After fixing the warning, `fuse-green.json` records the exact `--reuse-cache` invocation, 1,284 ms for two mounts, no additional object fetches and empty stderr. The worker/domain is real; no Linux mount is simulated. Required authentication stays in `SQUALI_TOKEN`.
- `python3 scripts/import-source.py PROJECT EXISTING_GIT_REPOSITORY --state PRIVATE_STATE_DIRECTORY`: resumable native importer. Explicit object, byte, request, per-invocation batch and time ceilings are described in `docs/source-import-budget.md`.

## Production checkpoints

- `production-pilot.json`: 8 objects, 2 commits, annotated tag, native tree equality, 3 R2 source write reservations and no additional Artifacts calls.
- `private-pilot.json`: 2,048 objects / 41,511,548 raw bytes admitted from the existing private-fixture cache. 829 new content write reservations; 43 HTTP attempts including preflight and batches. Full source inventory: 421,219 objects, 8,332,097,572 raw bytes. The initial preparation plus pilot took 113.667 seconds.
- The next continuation stopped at cursor 5,248 on a historic `100664` tree mode. `historic-mode-red.txt` reproduces the exact original Git tree; `historic-mode-green.txt` verifies compatible reads and byte-exact rebuilding. Latin-1 metadata and file/directory transitions have separate regression evidence. Successful earlier objects are reused.
- Source R2 bucket: `squali-source`, Standard, WNAM. Its only default lifecycle rule aborts incomplete multipart uploads; completed source objects do not expire. R2 analytics initially lagged and reported zero objects, so application reservation counts are explicitly distinguished from provider billing.
- Production Worker version `26a3182a-69d9-4063-be05-07057c223110` includes the historical-mode, raw metadata, eager graph and path-index fixes. The latest `indexes` rebuild endpoint is local pending the next deployment.

## Boundaries still open

The FUSE mount is currently immutable/read-only; writable edits use the existing working-copy client and HTTP change workflow. Published Git clone/fetch and native import seeding are now implemented and covered by local native-Git E2E tests. The production background runner is installed. The large private import, final UI/font checks, complete load/cost comparison, and other fixed-checklist items remain open. None of these are counted as complete by this evidence.

### Native GitHub background jobs

- `node --import tsx --test tests/native-jobs.test.ts`: `native-jobs-red.txt`, `native-jobs-green.txt`, `native-ui-red.txt`, `native-ui-green.txt`; full Clerk/GitHub HTTP fixtures, real native Git transfer, real PostgreSQL, queue/pause/resume, competing runner exclusion, owner isolation, hidden job credentials, replay with no new transfer, mobile browser screenshot.
- `node --import tsx --test tests/source.test.ts`: `source-native-finish.txt`, 11 passed after integrating atomic import completion and job-token revocation.
- `node --import tsx --test --test-name-pattern='continuous rebase' tests/rebase.test.ts`: `rebase-series-red.txt` and `rebase-series-green.txt`, native Git tree equality, restart, conflict resume, fresh review.
- `pnpm test:ui` against a fresh `startLocal({port:0,test:true})`: `ui-suite.txt`, three passed and a cold Adobe connection exceeded its budget. Follow-up `pnpm test:ui --grep 'Adobe resolves'` is in `ui-fonts.txt`: warm-navigation custom Proxima Nova and native PingFang SC confirmed, `ui/runtime.json` and screenshots. The cold failure artifact remains visible.
- `native-deploy.txt`: Worker d2400c6e-bae5-42db-8946-457fa2582c77, source GitHub queue enabled. A newer deployment is recorded below.
- `import-worker-timing.json`: three production trace samples from the ongoing import; CPU 15–133 ms, wall 176–3850 ms. This is a diagnostic sample, not a final throughput benchmark.

## Latest checkpoint

- `final-api-checkpoint.txt`: `node --import tsx --test tests/*.test.ts`, 57/57 passed. `seal-typecheck.txt`: `pnpm typecheck`. `final-core-build.txt`: `pnpm build`.
- `final-core-deploy.txt`: Worker `bc166f81-5d57-4b64-9f61-a5927aaad931`, custom domain only, source authority default, graph/path indices, continuous rebase, semantics, native bridge and batch sealing deployed.
- `seal-batch-red.txt` / `seal-batch-green.txt`: 128 native commits, 1,793 -> 18 database round trips; resulting content and graph generation verified.
- `import-keepalive-red.txt` / `import-keepalive-green.txt`: one HTTP connection per importer segment, saved cursors, zero HTTP on completed replay.
- `native-segments-red.txt` / `native-segments-green.txt`: forced one-second checkpoint continues in one job; one GitHub transfer and one native attempt.
- `rebase-source-authority.txt`: continuous rebase on canonical source storage; restart and conflict continuation, fresh review, independent native Git tree comparison.
- `source-git-recovery.txt`, `source-git-isolation-red.txt`, `native-export-tags-green.txt`: published-only clone/fetch, incremental export, per-workspace isolation, unknown push acknowledgement, provider deletion/rebuild, annotated blob tags and nested tags.
- `gzip-retry-red.txt` / `gzip-retry-green.txt`: different valid gzip encoding plus lost retry acknowledgement recovers with exactly two total PUT attempts.
- Private import checkpoint at 2026-10-14T20:31:35Z: 82,688/421,219 objects, 1,697 persistent HTTP attempts, 720,241,861 compressed uploaded bytes. This is progress, not completed acceptance.
- Real production login reached the Clerk-hosted `accounts.squa.li` page, which is held at Cloudflare security verification. User assistance is pending. Local fixture results do not substitute for that production login gate.

- `final-e2e.txt`: earlier full suite, 59 passed; `final-typecheck.txt` records type checking.
- `single-connection-red.txt`, `git-single-connection-red.txt` and green counterparts reproduce and fix connection starvation. Semantic review, source-backed continuous rebase and Git clone/fetch work with one database connection. `git-lease-concurrency.txt` also proves a slow export leaves capacity for another workspace and rejects a duplicate export.
- `seal-adaptive-red.txt` / `seal-adaptive-green.txt`: the importer splits a rejected 128-commit metadata batch into two 64-commit batches without repeating accepted work.
- `compatibility-limit-red.txt` / `compatibility-limit-green.txt`: a lower configured Git export budget forces the provider-limit branch; source import and reads still complete, the Git limit is explicit, and Artifacts calls remain zero. This is a controlled limit test, not a claim of a newly transferred 1 GB pack.
- The large import stopped at 96,640 objects with one `source_upload` failure. The database audit confirmed 38,343 ready blobs and one uploading blob (attempt 1, lease expires 20:47:04Z). Total source reservations were 38,347 writes and three reads. Successful writes are retained; recovery must inspect the one uncertain identity and preserve the journal.

## Current production acceptance

- `publication-full-e2e.txt`: 61/61 API/CLI tests pass. `publication-cost-red.txt` reproduces 128 unnecessary blob reads during 64-change preview/publication. The green transcript records zero blob reads/writes and 64 SQL queries. Typecheck and build transcripts are retained.
- `publication-deploy.txt`: source content reuse deployed as `eb108e64-a161-4edd-867f-b3ec7bbba843`.
- `cloud-baseline.json` and execution record: real Azure eastus2 client, 64 changes / eight concurrent clients, 2.094 changes/s, p95 5.317 s, publication 26.955 s. An initial agent credential was scoped to an older fixture; its nine denied requests are retained in the 152-attempt journal. Successful baseline creation was reused.
- `cloud-optimized.json`: after substantive publication optimization, one eight-change smoke reuses the baseline, admits eight new blobs and makes 25 requests. Publication 2.251 s; no Artifacts calls. One final verification file read accounts for the single source read. The different sample sizes do not establish a speedup ratio.
- `provider-r2-checkpoint.json`: Cloudflare provider analytics observed 42,212 source PUTs and 59 GETs at this checkpoint. Storage and operation analytics have ingestion lag and are not an invoice.
- `hyperdrive-performance.json` and `postgres-performance.json`: origin queries execute in IAD. PostgreSQL CPU peaked at 28.7%, memory at 72.1%, IOPS at 36, with 305 CPU credits remaining. Hyperdrive connection wait rises during concurrent samples.
- `production-github-login.png`: real authenticated production session and 97 authorized repository entries. The cropped screenshot excludes repository names. The specific private fixture row showed 118,912 / 421,219 objects, running, native attempt 1/3. Earlier Cloudflare verification is resolved.
- Adoption preserved 96,640 accepted object positions, 1,985 HTTP attempts, all old legacy attempts, and the native Git cache. It made no new GitHub transfer. The one uncertain blob was recovered; subsequent counters advance under the same finite job budget.

- `verification-full-e2e.txt`: 62/62 after adding the independent complete-import verifier; its local fixture checks all exported objects/refs, native fsck, history/blame and zero-transfer replay. `verify-import-red.txt` retains the missing-entry-point failure.
- `dev-default-red.txt` / `dev-default-green.txt`: the real `pnpm dev` entry point now creates source-backed workspaces by default. The retained local fixture IDs make the outcome inspectable.
- `pool-acceptance.txt`: 24 focused tests after lazy project lookup and one database connection per Worker request; `single-connection-concurrent.txt` checks eight concurrent clients with one local database connection. `pool-deploy.txt` records Worker `f5e53d14-c978-4137-b411-d9320e94e87f`.

- `source-ui.txt`: current source-default application, four browser E2E tests passed. Exact command: `SQUALI_URL=http://127.0.0.1:8799 WEAVE_UI_EVIDENCE=docs/evidence/2026-10-15-source/source-ui pnpm test:ui`; server: `startLocal({port:8799,test:true,source:true})`. Screenshots and actual Latin/CJK glyph provenance are retained in `source-ui/`.

- `proposal-full-e2e.txt`: 64/64 after direct online delta sealing and batched proposal paths. Four-file proposal SQL: 46 → 35; 64-file proposal: 97 → 34. Import re-sealing retains the exact changeset identity. `proposal-typecheck.txt`, `proposal-build.txt` and `proposal-deploy.txt` retain verification and Worker `49af2766-b09f-41ac-8d9d-5f8b5bea422e`.

- `rename-pool-full-e2e.txt`: 65/65. Retains the native edited-rename blame comparison, preservation of historical permission bytes during unrelated edits, and bounded rolling uploads. `blame-rename-red.txt`, `legacy-edit-red.txt` and `upload-pool-red.txt` record the prior failures. `upload-pool-green.txt` also verifies the final timer guard. Latest deployment: `9cca4890-8a8e-4dcf-85f5-debd3f83dc63`.
- `verify-import-fixture-count-failure.txt` is an earlier fixture assertion error (eight objects, initially expected nine); the final complete suites contain the corrected passing verifier.

- `node24-full-e2e.txt`: 65/65 with the exact pinned Node 24.21.0 runtime. Command: `/Users/binbinsh/.local/share/mise/installs/node/24.21.0/bin/node --import tsx --test tests/*.test.ts`.
- `demo-continuous-preflight.txt` and `recording-format.json`: the current demonstration workflow and a short continuous capture/MP4 format check pass. The quick probe is not a final competition video. See [recording instructions](../../demo-source.md).

## Unified derivation checkpoint

- `derived-full-e2e.txt`: 67/67 on pinned Node 24.21.0; `derived-typecheck.txt`, `derived-build.txt` and `derived-deploy.txt` retain the checks and Worker `788ca13e-62d5-4229-8d7a-52cf4e3eae93`.
- `derived-indexes-red.txt` / `derived-indexes-focused.txt`: eager and lazy graph/path derivation use one dependency mechanism. Deleting indexes and restarting, then requesting one head, rebuilds its parents and preserves merge ancestry/path history with zero extra blob I/O.
- `derived-bounds-red.txt` / `derived-bounds-green.txt`: oversized path events and missing canonical parents are rejected before a completion marker.
- Current SQL: 40 for four-file proposal, 39 for 64-file proposal, 21 for 128-commit sealing. Earlier transcripts retain their earlier revision counts.

- `derived-blame-full-e2e.txt`: 68/68, after routing recursive blame and cached metadata results through the shared resolver. Existing versioned cache keys are preserved. `derived-blame-baseline.txt` established the native rename/cache contract before the refactor; `derived-blame-focused.txt` verifies it afterward. `derived-blame-before.txt` retains an overly strict initial test assertion: rebuilding a missing head can fetch its current body and a rename candidate even when parent line results are cached. The corrected contract permits those two reads; a complete hot result permits none.
- `final-copy-ui.txt` and `final-copy-ui/`: four browser E2E tests pass after clarifying workspace/publication copy. Real Proxima Nova Latin and PingFang SC CJK, bounded fallback, navigation reuse, mobile layout and source history/blame are verified.

- `derived-blame-typecheck.txt`, `derived-blame-build.txt` and `derived-blame-deploy.txt`: current verification and production Worker `a428c389-bc06-42c8-b2f8-53b9a2d6b10e`.

- `verify-canonical-red.txt` / `verify-canonical-green.txt`: the final import verifier now checks a deterministic canonical-delta sample separately from Git export. The local E2E proves exact deltas/parents/content hashes/raw metadata and deliberately corrupts a canonical content address; verification stops before a second Git transfer. Production is limited to eight sampled changesets, still within 40 API attempts and one clone.
