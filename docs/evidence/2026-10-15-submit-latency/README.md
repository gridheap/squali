# Production submission latency evidence

## Scope and budget

The user requested stage measurements and a measured production optimization.
The retained `atomic` workload is not repeated. This experiment creates eight
new small changes in `source-acceptance-20261015`: four before and four after,
sequentially, using the same client, principal, frozen base and content length.
The normal plan is 32 HTTP requests including review/publication and all eight
file checks. One locked persistent journal bounds the whole run to 48 attempts,
at most three per identity; failures require explicit resumption. Completed
phases replay offline. There is no schedule, cache purge or large reimport.

Pricing and usage context was obtained earlier on October 15 and retained in
`../2026-10-15-write-path/provider-current.json` and `../../write-path.md`.
At $4.50/million R2 writes and $0.36/million reads, eight of each have an unrounded
operation value of $0.00003888. A conservative fixture envelope of 24 writes and
384 reads is $0.00024624. The existing 30,000 ms CPU ceiling times 48
requests times two Workers at $0.02/million CPU-ms is $0.0576 before included allowances. These
are estimates, not an invoice or a provider billing cap. Existing account base
fees and shared PostgreSQL capacity remain. No quota or infrastructure changes.

## Local commands

Use Node 24.21.0 from `/Users/binbinsh/.local/share/mise/installs/node/24.21.0/bin`.
The existing local PostgreSQL is reused; tests isolate their schemas.

```sh
node --import tsx --test tests/request-timing.test.ts
node --import tsx --test tests/request-timing.test.ts tests/write-path.test.ts
node --import tsx --test tests/latency-runner.test.ts
node --import tsx --test tests/prepared-seal.test.ts
node --import tsx --test tests/prepared-seal.test.ts tests/request-timing.test.ts tests/proposal-cost.test.ts tests/derived-indexes.test.ts tests/write-path.test.ts
pnpm test:e2e
pnpm typecheck
pnpm build
pnpm exec wrangler deploy
```

- `timing-red.txt`: HTTP timing expectations failed before implementation.
- `timing-green.txt`: timing isolation, R2 delay/failure, replay and existing write guarantees pass.
- `runner-red.txt`: runner absent before implementation. `runner-green.txt` retains the first failure: the timing parser excluded digits in `r2_put`. `runner-green-final.txt` passes after correcting it.
- `seal-red.txt`: existing behavior passed functional assertions but required 23–27 SQL statements with increasing ancestry depth, above the new 16-statement ceiling.
- `seal-green.txt`: 12 targeted tests pass, including 18-level ancestry, missing-index fallback, lazy/eager equality, atomic failure and no duplicate PUT on recovery.
- `full-e2e.txt`: all 96 tests pass, including existing native Git import/export, review, authentication, crash recovery and UI checks.
- `regression-artifacts/`: artifacts rewritten by this regression run. Original historical artifacts were restored after preserving these copies.
- `timing-typecheck.txt`, `seal-typecheck.txt`, `final-typecheck.txt`, `timing-build.txt`, `final-build.txt`: successful typecheck/build records.
- `timing-deploy.txt`: instrumentation baseline version `108bfa49-79e9-491c-a548-551ea8f897d4`.
- `optimized-deploy.txt`: optimized source deployment; regional deployment unchanged.

## Production command

`SQUALI_TOKEN` is loaded into the child process environment from the existing
private local credential file. Credentials are never written to these reports.
The retained administrator fixture principal is used; this does not demonstrate
independent reviewer identities or Clerk-session latency.

```sh
python3 scripts/profile-submissions.py source-acceptance-20261015 --state work/submission-profile --phase before --deployment 108bfa49-79e9-491c-a548-551ea8f897d4
```

Subsequent exact commands, deployment identities, every attempt, response timing,
usage and verification results are retained in the completed production journal.
Four samples per version establish a small controlled comparison, not p95/p99,
sustained throughput, CPU reduction or fleet-scale performance. Nested stage
durations overlap; the source Worker's monotonic clock measures I/O-oriented wall
time. Client minus Worker time includes transport and platform forwarding.

No competition submission is part of this work.

## Completed production commands and results

```sh
python3 scripts/profile-submissions.py source-acceptance-20261015 --state work/submission-profile --phase after --deployment 7218bc81-1798-4158-95fa-06243110b4a8
python3 scripts/profile-submissions.py source-acceptance-20261015 --state work/submission-profile --phase verify --deployment 7218bc81-1798-4158-95fa-06243110b4a8
python3 scripts/measure-provider.py --output docs/evidence/2026-10-15-submit-latency/provider-current.json
```

`production-before.txt`, `production-after.txt`, `production-verify.txt`,
`production.json` and `production-journal.json` retain the 32 successful HTTP
attempts and verification of every published file. There are no network failures,
retries or queued follow-ups. Source reservations are +8 writes / +8 reads;
Artifacts +0. The provider snapshot and lag are recorded separately in
`provider-comparison.json`. The final production journal is retained privately in
`work/submission-profile`; rerunning its completed phase is offline.

`instrumentation-baseline.patch`, applied with `git apply --unidiff-zero` to a separate checkout of `566096b`,
reconstructs the instrumentation-only baseline behavior for local reproduction.
The patch's extra TypeScript stage names are erased at build time and do not add
spans to that baseline. `production.json` records the actual deployed version.
See [the measured result and remaining limits](../../submission-latency.md).

Baseline patch validation first rejected an absolute `--directory` path; the
repository-relative path check passes. Both validation transcripts are retained.
