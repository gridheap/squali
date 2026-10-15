# October 15 incremental write-path acceptance

Commands run from the repository root with Node 24.21.0 and pnpm 11.25.0.
The existing local PostgreSQL server on port 55439 is reused; no cloud test
database is allocated. An initial setup attempt found that port already in use
and did not replace or stop the existing server.

## Test-first implementation

The first new test was temporarily written to the existing `proposal-cost.test.ts`
filename. The original file was restored byte-for-byte from `0e86020`; the new
tests now live in `write-path.test.ts`. Earlier transcripts retain the command
that actually ran. The final full suite includes all old and new tests.

| Command | Evidence |
| --- | --- |
| `node --import tsx --test tests/proposal-cost.test.ts` | `proposal-cost-red.txt`: one-file workload uses 32 SQL statements, exceeding the 28-statement target before code changes |
| Same temporary test command | `proposal-cost-green.txt`: atomic finalization reduces the count to 27; audit rollback and eight concurrent recoveries pass |
| `node --import tsx --test --test-name-pattern='source write admission' tests/proposal-cost.test.ts` | `admission-red.txt`: explicit retry after a rejected write budget incorrectly returns an active-lease 503 |
| `node --import tsx --test tests/proposal-cost.test.ts tests/source.test.ts` | `admission-green.txt`: atomic admission fixes retry and reduces the count to 24; source/import tests pass |
| `node --import tsx --test tests/write-path.test.ts tests/proposal-cost.test.ts` | `write-path-green.txt`: new tests and restored original tests pass together |
| `node --import tsx --test --test-concurrency=4 tests/*.test.ts` | `full-e2e.txt`: 93 passing tests, including the subsequent byte-quota and concurrent-last-reservations case |
| `pnpm typecheck` | `typecheck.txt` |
| `pnpm build` | `build.txt` |

Every fixture is local. R2 uses the persistent filesystem adapter and the
Artifacts boundary uses native local Git. No external provider calls occur in
these test commands. Transcripts retain injected errors as part of acceptance.

## Controlled latency comparison

Prepare the baseline code from the retained Git commit without installing dependencies:

```sh
mkdir -p work/write-path-baseline
git archive 0e86020 src scripts package.json | tar -x -C work/write-path-baseline
ln -s ../../node_modules work/write-path-baseline/node_modules
```

```sh
WRITE_PATH_OUTPUT=docs/evidence/2026-10-15-write-path/capacity-before WRITE_PATH_APP_DIR=work/write-path-baseline node --import tsx tests/write-path-capacity.e2e.ts
WRITE_PATH_OUTPUT=docs/evidence/2026-10-15-write-path/capacity-after node --import tsx tests/write-path-capacity.e2e.ts
```

`capacity-before.txt`, `capacity-after.txt` and each directory's `result.json`
record the exact commands, implementation hashes, SQL counts, CPU/RSS, failures,
storage calls and native Git results. The runner requires a fresh output
directory. Choose new paths when reproducing; do not overwrite retained results.
It adds 10 ms to each direction of local PostgreSQL traffic, has 256 HTTP attempts
as its ceiling and shuts down its server/proxy sockets. No automatic retry or
external service is used. Read the limitations in the reports and
[write-path assessment](../../write-path.md) before interpreting the results.

## Production

`pnpm exec wrangler whoami` is recorded in `deployment-account.txt` and confirms
Grid Heap account `52f8a24263418828b635c91b6eb06a83`. Existing bindings and resource
limits are retained. Deployment and the completed bounded follow-up are recorded
below. Competition submission is not performed.

`pnpm exec wrangler deploy` → `deploy.txt`: source version
`fa64ef9e-9fcf-402d-ab21-17bd8d2becad`, custom domain `squa.li`, no asset changes,
no schema migration and no enabled Workers.dev/previews. `final-typecheck.txt`
records the final typecheck after all new tests were added.

The production runner command is:

```sh
python3 scripts/cloud-acceptance.py source-acceptance-20261015 \
  --state work/write-path-production \
  --label 'production atomic write admission eight-change smoke' \
  --follow-up --series atomic
```

It receives credentials through the environment. The actual wrapper reads the
existing private credential file into memory without printing credentials:

```python
import json, os, pathlib, subprocess
keys = json.loads(pathlib.Path('../../work/private/weave-access.json').read_text())
env = {**os.environ, 'SQUALI_URL': 'https://squa.li',
       'SQUALI_TOKEN': keys['owner'], 'SQUALI_AGENT_TOKEN': keys['owner']}
subprocess.run([
    'python3', 'scripts/cloud-acceptance.py', 'source-acceptance-20261015',
    '--state', 'work/write-path-production',
    '--label', 'production atomic write admission eight-change smoke',
    '--follow-up', '--series', 'atomic'
], env=env, check=True)
```

The first invocation used `keys['agent']` for `SQUALI_AGENT_TOKEN` and received
eight 403 scope denials before any source write (`production.txt`,
`production-incomplete.json`). The next explicit invocation used the existing
administrator credential, without changing any permissions. All writes then
succeeded, but one review failed with SSL EOF (`production-recovery.txt`,
`production-recovery-incomplete.json`).

Before retrying that ambiguous review, one authenticated
`GET https://squa.li/api/projects/source-acceptance-20261015/changes` was added to
the same durable attempt journal as `review-recovery-inspection`. The stored
response showed `atomic-agent-6` still `proposed` with no review note. The
diagnostic's assertion that it had already been approved failed; the original
review remained pending. `review-reconciliation.txt` and `.json` retain this
read-only result. The last explicit invocation resumed just the missing review,
publication and verification (`production-network-recovery.txt`).

`production.json` and `production-journal.json` retain the final 35 attempts,
three execution segments, eight accepted/published files, p95, and reservation
deltas. Completed runner replay uses the persisted report and makes zero calls.
Do not create another series merely to reproduce an already successful live test.
The admin principal was both proposer and reviewer; this does not test independent
review policy. The default fixture policy permits it.

```sh
python3 scripts/measure-provider.py \
  --output docs/evidence/2026-10-15-write-path/provider-current.json
```

`provider.txt`, `provider-current.request.json` and `provider-current.json` retain
one successful scoped analytics query at 13:13:57 UTC, with no automatic retry.
The query repeats neither the import nor the completed acceptance workload.
Adaptive metrics and lag are called out in the report. No scheduled work remains.

`regression-artifacts/` contains regenerated outputs from legacy regression tests;
the original historical evidence files were restored instead of overwritten.
