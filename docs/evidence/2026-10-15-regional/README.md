# Regional cache acceptance

Local PostgreSQL, local source storage, real Python node processes, local Cloudflare workerd and the existing local Colima Linux VM. No cloud repository was re-imported or cloned. Provider calls for the test fixtures: zero.

Use the pinned Node 24.21.0 and pnpm 11.25.0 from the repository environment.

| Exact command | Result |
|---|---|
| `node --import tsx --test tests/regional-cache.test.ts` | `red.txt`: missing implementation; `probe.txt` and `clock-probe.txt`: retained cooldown/clock harness failures; `stream-timeout-red.txt`: abandoned stream retains its record before the fix |
| `node --import tsx --test tests/node-regional.test.ts` | `node-red.txt`: the old daemon attempts an authorization route outside the regional RPC |
| `node --import tsx --test tests/regional-cache.test.ts tests/node-regional.test.ts tests/node-cache.test.ts` | `green.txt`: shared immutable reads, scope/project isolation, expiry, live head, corruption, outage, timeout, stream cancellation and two real daemons |
| `node --import tsx tests/regional-worker.e2e.ts` | `workerd-red.txt` and `workerd-red-transcript.txt`: missing Worker entry point; `workerd-green.txt`, `workerd-transcript.txt`, `workerd-result.json`: actual workerd/service binding/Cache API |
| `node --import tsx tests/virtual-workspace.e2e.ts` | `virtual-workspace-green.txt` and `virtual-workspace-result.json`: real Linux writable overlay through node → regional cache → source |
| `node --import tsx --test --test-concurrency=4 tests/*.test.ts` | `full-e2e.txt`: 88 passing tests |
| `pnpm typecheck` | `typecheck.txt` |
| `pnpm build` | `source-build.txt` |
| `pnpm exec wrangler deploy --dry-run --config wrangler.regional.jsonc --outdir dist/regional` | `regional-build.txt` |
| `pnpm exec wrangler deploy` | `source-deploy.txt`: version `c81e2b62-86d2-403a-92b0-e83056b77c02` |
| `pnpm exec wrangler deploy --config wrangler.regional.jsonc` | `regional-deploy.txt`: version `c71c1cbb-4e09-418f-bfa9-e0f850862fe4` |
| `python3 scripts/verify-regional.py --access ../../work/private/weave-access.json --fixture ../../work/private/source-pilot.json --principal owner --prior-report docs/evidence/2026-10-15-regional/production-reader-denied.json --output docs/evidence/2026-10-15-regional/production-smoke.json` | `production-smoke.json`: regional miss/hit, exact retained object, project API preserved; completed replay performs no HTTP |

`result.json` summarizes the regional HTTP checks. Red results remain alongside passing results. All test-specific credentials are local fixtures. Production deployment and smoke evidence, when present, are separate from these local measurements.

Production smoke consumed five HTTP attempts including one earlier denied reader credential. The reader's existing project scope excluded the retained fixture; an existing authorized credential completed the four read-only checks. No new credential/grant was made. `production-reader-denied.json` preserves the rejection. Private access files and source bodies are not part of this evidence package. The command depends on those retained local private inputs; it prints no credential and refuses to repeat a completed check.
