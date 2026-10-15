# Production browser acceptance

Site: https://squa.li/ . Existing Brave user session, Clerk production GitHub sign-in. Target: `gridheap/squali-private-git-benchmark`. The source fixture is a private copy of public Git history. No unrelated private repository was imported or included in these saved screenshots.

## Repeatable browser sequence

1. Open Squali in the authorized signed-in browser. Complete ordinary Clerk/GitHub sign-in when required. The production catalog lists 97 repositories authorized by this account; the target import shows complete, 421,219 / 421,219 objects and 85,563 changesets.
2. Select the target in **Current workspace**. Open **Source**, then **Open README.md**. The published head is `6de20f60`; the README blob is `46489b0971d04d02c1ba3eea5cd5c134e60c4f77`.
3. Open **File history**, then **Blame lines**. Rows and source text render successfully. Their independent native comparison is in `private-verification.json`.
4. Open **Changes**, include rejected changes and inspect `source-write-verification`. The proposal is rejected, shows its intent and immutable diff, and does not move the published head.
5. Open **Cost & limits**. Persistent source/cache/Artifacts reservations and finite caps render. Exact checkpoint counts are in `native-final-audit.json`.

Saved results: [source](private-production-source.png), [history](private-production-history.png), [blame](private-production-blame.png), [rejected change](private-production-rejected-change.png), [cost](private-production-cost.png). These are retained from the completed acceptance, not mockups.

## Final brand deployment smoke

Worker `ce9a475a-f4d8-423f-b762-a3d27c50c9bb`. Through the existing authenticated Brave profile: open `https://squa.li/`, click **Source**, open/close **README.md**, enter `README.md` in **Search repository paths**, click **Find paths**. The UI renders six matching paths and keeps the same published head. [Final production screenshot](brand-production.png) includes the five-shark emblem, `squa.li` wordmark, version 0.2 and GitHub session. No import or proposal was created during this smoke.

The exact scripted local UI command is `WEAVE_UI_EVIDENCE=docs/evidence/2026-10-15-source/brand-ui pnpm test:ui`, with `pnpm dev` serving the local source store on port 8787. [All five tests passed](brand-ui-suite.txt), including the new 320/390/768/1440 px branding checks. [Runtime glyph report](brand-ui/runtime.json): cold Adobe activation 5,375.5 ms, reviewer workflow readiness 5,503 ms, Proxima Nova Latin and native PingFang SC CJK, zero page errors. These are observed external-font timings, not universal page readiness guarantees. Font timeout fallback and navigation reuse also passed.
