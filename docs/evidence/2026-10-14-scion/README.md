# October 14 source-service acceptance

Commands ran from the repository root; results are stored alongside this file. Local tests use HTTP, real PostgreSQL and native Git; R2 and Clerk/GitHub provider boundaries use deterministic fixtures. No local benchmark sends cloud traffic.

| Command | Result |
|---|---|
| `pnpm test:e2e` | 15 passed; scion-final-api.txt |
| `pnpm test:crash` | 4 passed; scion-final-crash.txt |
| `pnpm test:github` | 2 comprehensive cases passed, including browser and import SIGKILL; reconcile-state-green.txt |
| `pnpm test:storage` | 2 passed, including interrupted-upload restart; cache-upload-green.txt |
| `pnpm test:sparse` | 2 passed; exact 2 MiB binary and shared-cache replay; sparse-final.txt |
| `pnpm test:metadata` | 2 passed; search-pagination-green.txt |
| `pnpm test:permissions` | 1 comprehensive case passed; transitive-scope-green.txt (including dependency-scope checks) |
| `SQUALI_URL=http://127.0.0.1:8797 pnpm test:ui` | 3 passed, 1 failed on live Adobe activation timeout; scion-final-ui.txt |
| `SQUALI_URL=http://127.0.0.1:8797 pnpm test:ui --grep 'Adobe resolves'` | One bounded retry also timed out; scion-font-retry.txt |
| `SQUALI_URL=http://127.0.0.1:8797 pnpm test:ui --grep-invert 'Adobe resolves'` | Final three workflow/fallback cases passed; scion-ui-final.txt. Does not replace the failed live-font result |
| `pnpm typecheck`, `pnpm build` | Passed |
| `SQUALI_COMPARE_DIR=docs/evidence/2026-10-14-scion/native-comparison pnpm exec tsx scripts/compare-git.ts` | Equal Git trees, both fsck pass; comparison.json |

Start the local database with `bash scripts/setup-local.sh` and the UI server with `PORT=8797 pnpm dev` before browser tests. Browser tests use installed Brave, never downloaded browsers. The network timeout is retained as a failure, not hidden by skipping or weakening the font assertion.

## Cloud evidence

- `cloud-read.json`: four read-only HTTP calls to the existing live fixture, immutable commit and path search results, 8 new Artifacts reservations and real R2 activity; no source writes.
- `large-private-fixture.json`: preparation and fsck of the source fixture only.
- `large-import-result.json`: three failed production transfer attempts and explicit destination-ref reconciliation. **Not a successful import.**
- `scion-final-schema-result.json`: additive SQL migration, 14 tables, intended role/schema.
- `scion-runcommand-cleanup.json`: Azure accepted deletion of the three temporary Run Command resources carrying protected parameters. This does not delete the fixture files or application database.

Application reservations count conservative attempted operations, including failures. They are not provider-measured billing calls. There is no background transfer, retry timer, queue consumer or full live load test.
