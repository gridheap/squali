# Scion parity follow-up evidence

Console logs retain their results; trailing whitespace is normalized for source control.

All tests here use local PostgreSQL, real native Git and authenticated HTTP/CLI entry points. They do not perform a paid cloud load test or retry the large private import.

Final E2E command, run from the repository root:

```sh
node --import tsx --test tests/graph.test.ts tests/metadata.test.ts tests/permissions.test.ts tests/sparse.test.ts tests/api.test.ts
```

Stored output: `final-e2e.txt`. The test fixtures are rebuilt from native Git and do not require retained temporary directories. The existing local PostgreSQL setup is described in the project README.

The graph fixture has 1,024 mainline commits and one alternate branch commit. Raw commit metadata is exported using `git cat-file --batch`, checked against native Git object IDs and repository ancestry, and uploaded through the HTTP API. Its new indexed ancestry/merge-base/bisect queries make no new provider reads. This is correctness and call-count evidence, not a cloud throughput benchmark.

The sparse client E2E kills the client with SIGKILL after its first real file replacement, then checks protection of a later user edit and successful resumption. The fault injector patches the filesystem boundary in a separate test preload; there is no crash hook in product code.

Red/green development records:

- `graph-red.txt` / `graph-green.txt`: bounded provider-backed graph indexing.
- `history-red.txt` / `history-green.txt`: skipping indexed unchanged tree spans.
- `index-status-red.txt` / `index-status-green.txt`: persistent progress, restart and multi-parent graphs. Command: `node --import tsx --test --test-name-pattern='criss-cross' tests/graph.test.ts`.
- `bulk-index-red.txt` / `graph-final.txt`: hash-verified bulk metadata. Red command used `--test-name-pattern='bounded resumable'`; green command ran all graph tests then present.
- `index-cli-red.txt` / `index-cli-green.txt`: bounded native-repository export CLI. Command: `node --import tsx --test --test-name-pattern='native-repository' tests/graph.test.ts`.
- `add-red.txt` / `add-green.txt`: explicit new files. Command: `node --import tsx --test --test-name-pattern='explicitly add' tests/sparse.test.ts`.
- `update-red.txt` / `update-green.txt`: working-copy update and real process death. Command: `node --import tsx --test --test-name-pattern='working-copy update' tests/sparse.test.ts`.
- `client-commit-red.txt` / `sparse-final.txt`: accepted server commit advances the working-copy base. Red used the `explicitly add` filter; green ran `node --import tsx --test tests/sparse.test.ts`.
- `regression.txt`: `node --import tsx --test tests/api.test.ts tests/metadata.test.ts tests/permissions.test.ts` before final integration.

Historical red and intermediate green files describe those development stages. Use `final-e2e.txt` for the final integrated result, not a sum of every recorded pass count.

## Production verification

Deployment command: `pnpm deploy`. Stored output: `deploy.txt`.
Worker version: `0e2128b8-320a-4d28-aec4-62e110c525be`, served on https://squa.li with previews disabled.

The schema migration completed on Azure PostgreSQL (16 application tables). `schema-result.json` contains the selected non-secret execution result. `schema-cleanup.txt` records the successful deletion of the temporary Run Command resource after migration.

The bounded production check used six authenticated HTTP calls: usage, index step, index status, merge-base, reader rejection, and usage again. `cloud-graph.json` contains exact paths/bodies through the stored script and results. It indexed two existing commits, reserved two new Artifacts calls, eight R2 reads and four R2 writes; no Git source changes or large import transfers occurred. Provider-measured billing was unavailable; these are conservative application reservations. No automatic retries or background work were started.

Run the checked-in smoke script with `SQUALI_URL`, `SQUALI_TOKEN` (an unrestricted admin), `SQUALI_READER_TOKEN`, `SQUALI_PROJECT`, `SQUALI_REF` (an existing small immutable commit) and `SQUALI_SMOKE_RESULT`. It saves each completed step and a six-attempt ceiling to the result file; repeat invocations reuse it. Do not delete the result merely to rerun paid checks.

```sh
node scripts/verify-graph.mjs
```

The first run used the equivalent private-credential wrapper `python3 work/scion-graph-smoke.py` from the task directory; that exact command is retained in `cloud-graph.json`. Credentials and account access files are not part of the evidence.
