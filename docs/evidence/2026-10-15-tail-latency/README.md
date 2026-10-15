# Tail-latency evidence

Read [the assessment](../../tail-latency.md) and [the bounded plan](plan.md).
All commands run from the repository root. Toolchain: Node 24.21.0, pnpm 11.25.0,
Postgres.js 3.4.9, Wrangler 4.150.0, PostgreSQL 17.11. No dependency installation.

## Repeatable local acceptance

```sh
export PATH=/Users/binbinsh/.local/share/mise/installs/node/24.21.0/bin:$PATH
node --import tsx --test --test-timeout=60000 tests/database-startup.test.ts tests/request-timing.test.ts
node --import tsx --test tests/node-regional.test.ts
node --import tsx tests/source-routing.e2e.ts
pnpm test:e2e
node --import tsx --test tests/tail-runner.test.ts
pnpm typecheck
pnpm build
```

These use the existing local PostgreSQL and local HTTP/workerd/R2 fixtures.
`database-startup-final-green.txt` records one catalog query over 27 fresh clients.
`source-routing-result.json` and its transcript verify the actual source Worker,
regional Worker and named binding, new/legacy RPC paths, cache hits, denial,
four submissions and publication. `regression.txt` records 98/98 tests passing.
`pilot-read-green.txt` records the later first-draft readback addition. Typecheck
and build logs are stored here. Prior evidence files overwritten by the tests
were copied to `regression-artifacts/`, then their historical originals restored.

Development failures are retained rather than replaced. Files whose names end
in `green` can still contain a failed intermediate attempt; the authoritative
passing files are the ones named explicitly above. In particular, the first
codec attempt exceeded its bound in the accumulated shared catalog; the next
isolated attempt hung in driver reserve; incomplete discovery snapshots then
failed array decoding. These were fixed before optimized deployment. The first
source-routing run lacked the new named entrypoint; its next run caught a test
expectation of 200 where publication correctly returns 201.

## Production sequence

1. Source timing baseline `0a5c615e-bdae-458a-b375-bec01a8c5772`; regional timing
   `0e8fad09-be63-498c-b6cf-ec1e183f953c`. See `timing-*-deploy.txt`.
2. Eight-request baseline pilot, then extend the same journal to 256.
3. `pnpm exec wrangler r2 bucket local-uploads enable squali-source`.
   `r2-before.json`, `r2-enable.txt` and `r2-after.txt` record settings and verification.
4. `pnpm exec wrangler deploy` without the source REGIONAL binding, exporting
   SourceRpc first: `c552416e-5296-485c-bb56-1016d272c111`.
5. `pnpm exec wrangler deploy --config wrangler.regional.jsonc`: dedicated route,
   named source binding, `a1789d85-bc0a-4e27-98c5-f83b73432984`.
6. `pnpm exec wrangler deploy` with source REGIONAL compatibility binding:
   `30ffa419-b45a-48ac-9922-50c957a28f17`.
7. Eight-request optimized pilot; one TLS EOF and one same-ID explicit recovery.
   Read back the first draft before expanding the run. All eight writes accounted.
8. Four production route checks with `scripts/verify-tail-routing.py`, sharing
   the same journal and 640-attempt cap. Extend optimized phase to 256, then verify
   publication and eight selected files.
9. One provider analytics query. It returns rate-limit budget depletion; there
   is no repeat query. See `provider-current.json` and `provider-observation.txt`.

Exact measurement commands (the journal also records them):

```sh
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase before --deployment 0a5c615e-bdae-458a-b375-bec01a8c5772 --through 8
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase before --deployment 0a5c615e-bdae-458a-b375-bec01a8c5772
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase after --deployment 30ffa419-b45a-48ac-9922-50c957a28f17 --through 8
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase after --deployment 30ffa419-b45a-48ac-9922-50c957a28f17 --through 8 --resume
python3 scripts/verify-tail-routing.py --state work/tail-profile
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase after --deployment 30ffa419-b45a-48ac-9922-50c957a28f17
python3 scripts/measure-tail.py source-acceptance-20261015 --state work/tail-profile --phase verify --deployment 30ffa419-b45a-48ac-9922-50c957a28f17
python3 scripts/measure-provider.py --output docs/evidence/2026-10-15-tail-latency/provider-current.json
```

`SQUALI_URL` was https://squa.li. `SQUALI_TOKEN` was injected into the child process
from the existing private owner credential file, never printed or supplied as a
command argument. Do not start another live run with a new journal to reproduce
the arithmetic. Use `production-report.json`, `production-journal.json` and
`comparison.json` offline. Completed phases replay offline with their original
journal. To inspect without credentials:

```sh
python3 - <<'PY'
import json,math,statistics
r=json.load(open('docs/evidence/2026-10-15-tail-latency/production-report.json'))
for phase in ('before','after'):
    p=r['phases'][phase];v=sorted(x['clientMs'] for x in p['samples'])
    print(phase,len(v),'p50',statistics.median(v),'p95',v[math.ceil(len(v)*.95)-1],
          'p99',v[math.ceil(len(v)*.99)-1],'max',v[-1], 'failed first attempts',p['failures'])
print('HTTP attempts',r['httpAttempts'],'usage',r['usageDelta'],'verified files',r['verifiedFiles'])
PY
```

The journals preserve response fixture content and IDs but no credentials.
These are short bounded phase measurements, not long-duration production SLOs.
