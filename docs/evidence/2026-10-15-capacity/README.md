# October 15 rebase and capacity evidence

All commands run from the repository root with Node 24.21.0 / pnpm 11.25.0. `capacity-run.py` starts its own PostgreSQL 17.11; other integration tests use the existing local test database. Linux tests use the existing local Colima VM. No D1, application Durable Object, dependency installation or new cloud resource was added.

## Functional acceptance

| Command | Stored result |
|---|---|
| `node --import tsx --test tests/workspace-rebase.test.ts` | `plan-red.txt`: endpoint absent before implementation |
| `node --import tsx --test tests/workspace-rebase.test.ts tests/rebase.test.ts` | `plan-green.txt`: deterministic no-write plan and existing commit/series rebase |
| `node --import tsx tests/virtual-rebase.e2e.ts` | `virtual-rebase-red.txt`, `virtual-rebase-crash-red.txt`, `virtual-rebase-receipt-red.txt` precede their fixes; `virtual-rebase-green.txt` + `virtual-rebase-result.json` pass real Linux/native Git checks |
| `SQUALI_EVIDENCE=docs/evidence/2026-10-15-capacity node --import tsx tests/virtual-workspace.e2e.ts` | `virtual-workspace-regression.txt`, `virtual-workspace-result.json`: existing edit/proposal/restart/disk-full behavior remains valid |
| `node --import tsx --test --test-concurrency=4 tests/*.test.ts` | `full-e2e.txt` and `final-e2e.txt`: 89 passing tests before/after fixed node workers; regenerated UI/watch artifacts retained under `regression-artifacts/` without overwriting earlier checkpoints |
| `pnpm typecheck` | `typecheck.txt` |
| `pnpm build` | `build.txt` |
| `pnpm exec wrangler whoami` | `deployment-account.txt`: Grid Heap account verified |
| `pnpm exec wrangler deploy` | `deploy.txt`: source version `4649cee6-4c4e-4876-a90d-af2ac0f4bd80`, existing domain, previews disabled |
| `python3 scripts/verify-rebase.py --access ../../work/private/weave-access.json --fixture ../../work/private/source-pilot.json --output docs/evidence/2026-10-15-capacity/production-rebase.json` | `production-rebase.json` / `.txt`: five successful bounded calls, exact plan, unchanged main, no source-write/read reservation increase; completed replay is offline |

## Capacity runs

The exact command for each directory is in `started.json` and `resources.json`. All use `python3 scripts/capacity-run.py --output docs/evidence/2026-10-15-capacity/DIRECTORY`, with the flags below. Each directory retains transcript, process resource samples and completed phases even when the run fails.

| Directory | Extra flags | Outcome |
|---|---|---|
| `pilot` | `--quick` | PostgreSQL Unix socket path exceeded macOS's length limit; no workload ran |
| `pilot-fixed` | `--quick` | Small complete run passed after using isolated TCP-only PostgreSQL |
| `full` | — | 19 warm-node connection failures under 128 concurrent clients |
| `full-bounded-node` | — | 111 kernel-backlog connection refusals; active-slot wait alone was insufficient |
| `full-bounded-backlog` | — | Complete 4,097-file, 128-client workload passed with bounded backlog |
| `sustained` | `--sustained` | Longer-run inspector handshake failed before longer phases; earlier phases retained |
| `heap-probe` | `--quick --sustained` | Small diagnostic confirmed inspector's required Origin header |
| `heap-origin` | `--quick --sustained` | Unavailable optional WebSocket module; workload did not start; no module was installed |
| `heap-native` | `--quick --sustained` | Pinned Node's built-in WebSocket with explicit local Origin passed |
| `sustained-measured` | `--sustained` | Complete longer workload passed; inspector records actual regional script identity and heap values |

Fixture object bytes remain under ignored `work/` directories. Reports contain deterministic test data/counters and local runtime paths, not production source bodies or credentials. These local fixture runs make zero cloud-provider calls. The measured native Git comparison is the functional rebase tree, not a claimed Git performance speedup.

## Provider reconciliation

`provider-denied.json`, `provider.request.json` and `provider.txt` retain the failed first query using the expired local session. The explicit recovery is:

```sh
python3 scripts/measure-provider.py \
  --prior-report docs/evidence/2026-10-15-capacity/provider-denied.json \
  --output docs/evidence/2026-10-15-capacity/provider-current.json
```

It uses the current Wrangler token internally without printing it. `provider-current.json` records two total attempts, the exact product-scoped query, response, timestamp and limitations. A complete replay reads the saved report. Production verification and provider queries have no automatic retry or scheduled recurrence. Competition submission was not performed.

## Fixed-worker CPU acceptance

`tests/node-cpu.e2e.ts` measures the real daemon over its Unix-socket interface against a local authenticated upstream fixture. It verifies every body, counts all failures and upstream requests, and measures CPU/RSS from the daemon's OS counters. No external provider is involved.

```sh
NODE_CPU_OUTPUT=docs/evidence/2026-10-15-capacity/node-cpu-baseline.json node --import tsx tests/node-cpu.e2e.ts
NODE_CPU_OUTPUT=docs/evidence/2026-10-15-capacity/node-cpu-red.json NODE_CPU_BASELINE=docs/evidence/2026-10-15-capacity/node-cpu-baseline.json node --import tsx tests/node-cpu.e2e.ts
NODE_CPU_OUTPUT=docs/evidence/2026-10-15-capacity/node-cpu-fixed.json NODE_CPU_BASELINE=docs/evidence/2026-10-15-capacity/node-cpu-baseline.json node --import tsx tests/node-cpu.e2e.ts
```

`node-cpu-metrics-red.txt` first fails because process CPU/RSS is absent. `node-cpu-baseline.json` records the original per-request threads; `node-cpu-red.json` fails the 20% improvement target before the fix. `node-cpu-fixed.json` passes with 20.36% less daemon CPU, 10.02% higher throughput and zero failed requests. Use a new local result path for reproducing measurements rather than overwriting retained baseline evidence. Hardware/OS scheduling can change performance; comparisons are optional and explicitly selected with `NODE_CPU_BASELINE`.

For an independent new baseline, set `NODE_DAEMON_SCRIPT=docs/evidence/2026-10-15-capacity/node-daemon-per-request.py` and choose a new `NODE_CPU_OUTPUT`. The retained pre-pool source snapshot keeps the same 32 active slots / 128 backlog / one-second admission wait and OS metrics as the original baseline. Then omit `NODE_DAEMON_SCRIPT` and compare the current daemon against that new baseline. New reports also record the selected script SHA-256. The snapshot is benchmark evidence, not an installed production client.

The final targeted `plan-green.txt` also covers a deletion resolution carrying an optional mode, whose preceding failure is `plan-delete-red.txt`. This ensures the server emits the canonical deletion shape expected by overlay validation.

The final response-normalization patch was built and deployed once more: `pnpm exec wrangler deploy`, saved in `deploy-canonical-plan.txt`, source version `33af85df-5716-4900-a00a-239dbbb6525f`. The five-call production report covers the preceding planner deployment; the final patch only canonicalizes optional fields in returned resolution patches and has the new targeted HTTP regression. No successful production load or import was repeated for that normalization.

Trailing whitespace in saved tool transcripts is normalized for Git checks; commands, response values, failures and timings are retained.
