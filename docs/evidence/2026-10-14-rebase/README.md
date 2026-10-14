# Single-commit rebase acceptance

This operation reapplies one immutable commit onto an explicit immutable target and creates a new, unapproved proposal. A merge commit requires an explicit parent number. It does not perform an interactive rewrite of an arbitrary branch or supersede the source proposal automatically.

## Reproduce locally

Run from the repository root with the local PostgreSQL prerequisite documented in README:

```sh
node --import tsx --test tests/rebase.test.ts tests/metadata.test.ts tests/permissions.test.ts tests/api.test.ts
pnpm typecheck
pnpm build
```

`final-e2e.txt` records 21 passing tests. The first rebase case compares the exact final tree against native Git cherry-pick and runs Git fsck. It also verifies independent target edits, additions/deletions, executable modes, explicit parentage, unchanged main, stable retries and fresh review. Further cases exercise three conflict types, explicit resolutions, rejected unrelated paths, parent ambiguity, missing targets, file/directory collision, and the 2 MiB aggregate comparison limit. The permission suite rejects directory-scoped rebase before provider access. The real CLI is exercised against the HTTP server.

`red.txt` is the initial missing-endpoint failure. `cli-red.txt` is the missing CLI route failure. `budget-red.txt` is the excessive-conflict-response failure. The latter two used `--test-name-pattern='matches native'` and `--test-name-pattern='aggregate conflict'` respectively. `green.txt` contains the earlier two-case pass; use `final-e2e.txt` for the final code.

`typecheck.txt` records the final typecheck. `build.txt` is an earlier successful dry run; `deploy.txt` includes the final Worker build and deployment after the comparison budget was added. Console trailing whitespace is normalized for source control.

## Production

Deployment command: `pnpm deploy`. Worker version: `f3fab78a-c7c3-4589-871e-4691a5b9cc50` at https://squa.li; previews remain disabled.

Bounded check:

```sh
node scripts/verify-rebase.mjs
```

Set `SQUALI_URL`, `SQUALI_PROJECT`, `SQUALI_REF`, `SQUALI_REBASE_ID`, `SQUALI_SMOKE_RESULT`, and an unrestricted administrator's `SQUALI_TOKEN` in the environment. The checked-in result contains the non-secret input values and every path/body/result. Credential injection is local and is not recorded. The script admits at most seven HTTP attempts, saves progress before each attempt, reuses completed results and performs no automatic retries. Keep the result file to avoid repeating paid work.

The test creates one unreviewed proposal, verifies its exact source tree and new parent, and compares main before/after. It does not publish it or restart a large import. `cloud-rebase.json` records the actual production outcome and conservative application usage reservations; these are not provider-measured billing. No background work is scheduled.

The completed production run used seven HTTP attempts and reserved 20 new Artifacts operations, eight R2 reads and eight R2 writes. Final counters were Artifacts 172/2,000, R2 reads 32/20,000 and R2 writes 20/2,000. Zero automatic retries and zero large-import transfers were dispatched.
