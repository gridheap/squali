# Apache comparator replacement

The final rules check found that the experimental in-tree LGPL comparator did
not meet the competition's permitted project-source licenses. The released
implementation is adapted from the separately Apache-2.0 licensed imara-diff
revision `f02e46a737c43c0d9c65a42e5e08046bd10fd739`. Attribution, upstream modules
and changes are in [licenses/imara-diff.md](../../../licenses/imara-diff.md).
The earlier LGPL source is not shipped or relabeled.

## Local evidence

- `node --import tsx --test tests/git-line-diff.test.ts tests/blame-native.test.ts tests/blame-budget.test.ts`: [135 native pairs and six focused tests](imara-separator-green.txt).
- The new separator case was first recorded failing in [imara-separator-red.txt](imara-separator-red.txt). Its original real-history pair was Git commit `6164972018ba3adbae2db1e7b286e2b811b3e7c2`, README.md. This pair now matches five native hunks in 1,761 comparison units: [real-pair report](imara-real-pair.json). Fetch that commit's README and reverse its commit patch to reproduce the two inputs; the report records both SHA-256 hashes. Run `node --import tsx scripts/compare-lines-native.ts before-file after-file`. The shipped regression uses synthetic record names.
- `node --import tsx --test --test-concurrency=4 tests/*.test.ts`: [84/84 final suite](imara-final-suite.txt).
- `pnpm typecheck`: [result](imara-final-typecheck.txt). `pnpm build`: [result](imara-final-build.txt).
- Blame caches advance to v4. The [v4 cache isolation failure](imara-v4-cache-red.txt) preceded the implementation; the final suite passes. Unrelated metadata/source cache identities remain unchanged. No backfill is scheduled.

## Production supplement

The first Apache deployment passed the local tests but attributed README line
17's blank separator to a later commit. [Saved failed UI regression summary](imara-production-blame-red.txt)
and [image](imara-production-blame-red.png) retain that failure. The earlier
[native-verified production screenshot](private-production-blame.png) shows
`17 · aa98eb3d:27`. This is a regression, not a changed acceptance criterion.

The exact one-time upstream query was:

```sh
gh api graphql -f query='query { repository(owner:"git", name:"git") { object(oid:"6de20f6092dcf9bdb1c8efe03db4b70c82b423dd") { ... on Commit { oid blame(path:"README.md") { ranges { startingLine endingLine commit { oid } } } } } } }'
```

Its [saved response](imara-upstream-source.json) is reused by the final local
comparison. No repeated upstream query is needed. Full commit origins are
compared for all 75 lines; original line positions are additionally checked
at seven regression points from native acceptance evidence. Local native tests
cover original positions across merges, renames, newline edits and long histories.

The full import/fsck/object/ref verification in [private-verification.json](private-verification.json)
remains the original accepted run, with its original timestamp and implementation.
It was not rerun or overwritten. The replacement's live response and comparison
are separate supplemental evidence.

An attempted additional Azure-side offline replay could not be inspected because
this Mac's Azure management HTTPS connection returned EOF/SSL errors. It is not
claimed as a pass. One existing diagnostic command resource was updated, with a
180-second execution ceiling, one read-only metadata query and no application,
GitHub, R2 or Artifacts calls. The local client metadata request was terminated;
no additional import, verification clone, recurring task or credential was created.

## Final v4 result

Worker `79cc8779-a322-4f22-9219-4e563007e799` is deployed. From the signed-in production Source page, open README.md and choose **Blame lines**. The captured [HTTP 200 response projection](imara-production-blame.json), [dialog regression summary](imara-production-blame.txt) and [screenshot](imara-production-blame.png) show the corrected result, including `17 · aa98eb3d:27`. The one request took 20.995 seconds, excluding Clerk refresh; [network timestamps](imara-production-network.json) retain this observation.

Reproduce the offline comparison with:

```sh
python3 scripts/compare-blame-report.py docs/evidence/2026-10-15-source/imara-production-blame.json docs/evidence/2026-10-15-source/imara-upstream-source.json --regressions docs/evidence/2026-10-15-source/imara-native-regression-points.json
```

[Result](imara-production-verification.json): **75/75 full commit origins and 7/7 original-line regression points match**, with zero additional HTTP calls or Git transfers. The continuous video predates this license replacement; the final implementation is verified by this separate supplement.

The public response retains only `ref`, `path`, commit origins and original line numbers. Full third-party README text and author details are omitted; the raw capture SHA-256 is recorded and the raw capture is retained privately. Screenshots provide the limited rendered context for the observed regression.
