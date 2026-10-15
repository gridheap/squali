# Source operations and bounded clients

Set `SQUALI_URL` and an appropriately scoped `SQUALI_TOKEN` in the process environment. Production defaults to source-backed workspaces. `pnpm dev` also defaults to source storage, using a persistent filesystem adapter for R2. Existing local legacy workspaces remain readable. A deployment must bind source storage before using these operations.

## Import an existing native repository

Create an empty workspace with `POST /api/projects` and `{ "id":"project", "name":"Project", "storage":"source", "import":true, "files":[] }`. Use an unrestricted administrator credential for that workspace.

```sh
python3 scripts/import-source.py project /path/to/repository.git \
  --state /path/to/retained-import-journal \
  --max-objects 500000 --max-bytes 17179869184 \
  --max-requests 12000 --max-batches 128 --max-seconds 900
```

The command validates a complete native object inventory before its first HTTP request. It freezes refs, default branch, destination and cumulative budgets. Reuse the exact command and journal to continue; changing those inputs is rejected. Exit 2 is a healthy checkpoint, exit 1 stops on an error, and exit 0 means complete. A completed replay performs no HTTP calls. A filesystem lock excludes overlapping importers.

Objects are hash-verified; blob uploads use individual gzip content addresses. Changesets are sealed in parent order and graph/path indexes are written in batches. Rejected metadata batches shrink their size; transient errors stop. Refs become available only when their closure is admitted. Heads and annotated tags, including nested and blob tags, are preserved. Native input, journal and source data are retained after failure. Do not erase them to force a retry.

The standalone importer populates canonical source data. Large initial Artifacts seeding is restricted to the native job runner's live internal lease. The browser's GitHub workflow queues that runner automatically when `NATIVE_IMPORTS=true`. Small derived Git exports can be built by the authenticated Git endpoint. An oversized compatibility copy explicitly remains unavailable while source APIs stay usable.

## Native GitHub runner

The operator installs Python 3, Git and pinned `pg8000` plus its dependencies. Inject `SQUALI_WORKER_DATABASE_URL`, `SQUALI_URL` and optional `SQUALI_DB_SCHEMA` through a protected environment file. Run as a dedicated unprivileged service user:

```sh
python3 scripts/native-jobs.py --root /var/lib/squali-native \
  --max-jobs 1000 --max-seconds 28800
```

Use one service with a 1 GiB memory bound, a writable private state directory, private temporary space, finite runtime and a restart-rate limit. The PostgreSQL fleet lock prevents a second active consumer. Each job has an eight-hour cumulative limit and at most three explicit attempts. Service restart marks an interrupted running job failed; it does not retry that job. Database notifications and a 30-second reconciliation check wake queued work. The runner never polls the paid HTTP API while idle.

Keep the native Git cache, `cache.json` identity marker and `state/state.json` together. Do not move a live job, replace its token, change frozen refs or reset attempt counters. The deployment recovery guide applies to ambiguous provider outcomes.

## Inspect and reconstruct source data

Whole-workspace credentials can read `GET /api/projects/:id/changesets/:gitOidOrChangesetId`. Administrators can inspect `GET /api/projects/:id/source`, including object counts, changesets, refs and Git compatibility status.

`POST /api/projects/:id/source/derive` accepts `{ "kind":"tree", "version":1, "changesets":["<immutable-id>"] }` or kind `generation`. Kind `indexes` rebuilds graph/path structures and resolves missing parent dependencies through the same versioned engine used for tree/generation results. It accepts a single head when the missing closure fits the limits: 1,024 results, 8,192 dependency records, 16 MiB graph/path metadata and 100,000 path events. Larger rebuilds use parent-order batches. Eager and lazy paths share the resolver; storage and vectorized calculations are adapters. Unknown kinds and versions are rejected.

The authenticated raw source protocol is `POST /api/projects/:id/rpc` with operations `head`, `object` and `stat`. Directory-scoped credentials must use authorized path APIs. See the [node cache guide](node-cache.md) for its clients.

## Continuous rebase

```sh
node scripts/squali.mjs rebase-series project < rebase-series.json
```

Use immutable source/target identities and the same operation ID when continuing. A series contains at most 64 single-parent commits, processes up to eight steps per request, and retains conflicts for explicit resolution. Main remains unchanged. Every resulting proposal requires fresh review. See [the API contract](api.md) for the exact request fields.

## Automatic first-parent bisect

```sh
python3 scripts/bisect-run.py project GOOD_COMMIT BAD_COMMIT \
  --state /path/to/bisect-journal --file src/check.py \
  --steps 8 --test-seconds 60 -- python3 src/check.py
```

Both endpoints must be immutable 40-character Git IDs. The explicit test command runs in a sparse disposable directory containing the selected files. It receives a minimal environment without Squali credentials. This is a test runner, not a sandbox for untrusted code. Exit 0 classifies a commit good; 1–124 classifies it bad; 125, signals and execution errors stop as inconclusive. The runner verifies both supplied endpoints.

Select 1–32 regular files. Limits are 1 MiB per fetched response, 16 MiB per checkout, 64 MiB downloaded, 64 tests and 512 HTTP attempts across resumes; each test gets at most 300 seconds and 1 MiB output. Reusing the journal reuses known classifications and verified blobs. A complete replay performs no HTTP calls.

## One production acceptance sample

Run this only after admitting its cost and confirming that its chosen project ID is unused or belongs to the retained journal:

```sh
python3 scripts/cloud-acceptance.py source-acceptance-20261015 \
  --state /path/to/retained-acceptance \
  --label 'production Azure eastus2 to Cloudflare'
```

This is a fixed 64-change, eight-client sample with 64 baseline files, 64 approvals and one publication. It performs 143 requests on a healthy run and admits at most 160 attempts, with no automatic retries. Expected unique content is 128 blobs. It retains every successful step, request latency, exact invocation and a final report. Completed replay performs no network calls. `SQUALI_AGENT_TOKEN` optionally supplies a separate agent role; the owner token approves and publishes.

The report names client location and records global application counters, which may include concurrent imports. Eight clients can share one agent principal; this does not imply eight separately authenticated users. A repeated file read is a cache observation, not proof that the first read started with all cache layers empty. Preserve failed or resumed samples and state their timing limitations.

After a substantive performance change, `--follow-up` admits one eight-change sample in the same workspace, with a separate retained journal. It reuses the baseline, writes eight new blobs, and has a 40-request total ceiling (25 healthy requests). It does not recreate or rerun the successful 64-change baseline. Give a later justified follow-up a stable `--series` name and its own retained journal; a completed series must not be repeated with a fresh name. Default series identity remains `optimized`. The result is a smaller smoke sample, not a directly comparable throughput benchmark.

## Independently verify a completed import

```sh
python3 scripts/verify-import.py PROJECT /path/to/retained-native.git \
  --state /path/to/verification-journal --file README.md
```

Use a whole-workspace administrator credential and frozen native input. The command checks source readiness, all ref identities, total objects and changesets, graph completion, root tree, sparse file bytes, ancestry, merge-base, bisect, path history and line origins. It then makes one authenticated mirror clone, runs native `git fsck`, and compares the entire exported reachable-object inventory and every branch/tag. Before cloning, a deterministic sample of up to eight changesets is checked against native Git for exact changed paths, blob SHA-256, parent identity mapping, raw permission bytes, original commit metadata and canonical SHA-256 identity. Samples and their parents admit at most 128 changed paths and two parents each; the whole run remains within 40 API attempts. Reports include the sampled IDs, inventory digest and exact invocation. Its cumulative ceiling is 40 API requests and one Git transfer. Completed replay performs no network work. A failed large transfer requires inspecting its retained outcome before recovery. Choose a file within the documented history/blame bounds; the report states that sample explicitly.

For an explicitly disposable acceptance repository, add `--write-smoke` to the first invocation. After native verification, it creates one proposal adding `squali-verification.txt`, verifies the canonical delta, content and unchanged neighboring entries, then rejects the proposal. Published refs and the frozen native input remain unchanged. The proposal and its source objects remain as evidence; inventory counts in the report describe the original import. This mode has a 48-request ceiling, uses the same single clone and retains its timings/replay journal. Do not change modes or start a new journal to repeat successful work.

The complete-import verifier records response timings in its private journal and compact observed API, history/blame, ancestry, merge-base, clone and fsck timings in the final report. They describe that one verification run. A completed replay returns the original measurements and performs no additional HTTP or Git transfer. A request interrupted before receiving a response has no fabricated response timing; its attempt still counts in the persistent budget.
