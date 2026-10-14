# Original goal and submission readiness

**Not ready for final submission. Full Scion parity is not complete.** The goal is an online source-control service with strong performance and cost efficiency, using Workers, Artifacts and R2, without D1. The [Scion capability map](scion-parity.md) is the acceptance boundary.

## Verified

- Incremental immutable proposals, context/dependencies, review, conflict revisions and selected batch publication. New publications retain the proposal commits as additional Git parents; deterministic recovery journals freeze that parent list.
- Fifteen HTTP/Git workflow tests and four real publication/cancellation SIGKILL tests pass.
- Clerk/GitHub integration tests cover owner isolation, progressive permission, private history/branches/tags, import recovery after SIGKILL, explicit destination reconciliation and directory credentials.
- R2 tier restart/failure isolation, sparse and binary materialization, graph/diff/history/blame/revert/bisect queries, search pagination and path policy have saved end-to-end results.
- Three current browser workflow/fallback tests pass. The full browser run's live Adobe activation test timed out twice under the current network; its workflow completed, but glyph activation did not pass in these runs. Earlier successful glyph evidence remains historical, not a substitute for this result.
- Local native-Git comparison uses identical content and ancestry-preserving publication on both paths, with native clone/fsck verification. See [performance](performance.md).
- Production Clerk configuration and real GitHub sign-in work. The R2 bucket, seven-day lifecycle, updated SQL schema and Worker are deployed at https://squa.li. Legacy workers.dev and preview URLs remain disabled.

## Still required

1. Complete and independently verify the large private repository import. Its 85,563-commit source fixture passed fsck; three production transfers did not complete. Do not reset the attempt ceiling or label the fixture preparation a successful Squali import.
2. Complete general path/blame indices, richer semantic approval, archive navigation, changeset/storage architecture and filesystem virtualization. Generation/skip indexing, verified metadata import and journaled working-copy updates now have local E2E evidence. These improvements do not establish full Scion parity.
3. Measure sustained mixed contention, CPU/memory, cold/warm cache behavior and cloud cost per successful workflow. The small local sample does not establish universal highest performance or best value.
4. Replace the older edited demo with a continuous capture of current behavior and accurate limitations. Then have the eligible team member perform the competition submission.

The competition asks for Workers, Artifacts, concurrent agent changes, an open-source license, runnable instructions and a 5–10 minute video. Its format requirements do not by themselves establish product readiness. No submission has been made.

Sources: [article](https://www.anthropic.com/engineering/redesigning-source-control), [competition](https://www.cloudflare.com/git-competition/), [rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).
