# Source and snapshot review

Baseline: `8a2d963`; initial review through `cc3d400`, followed by the snapshot worktree diff. Commands: `git diff 8a2d963...cc3d400` and `git diff cc3d400`. The two review axes ran independently. Requirements came from the fixed Scion checklist, source architecture and failure specification. Review did not run additional cloud operations.

## Standards

- The initial committed diff had no documented-standard violation. A possible duplicated Git environment-sanitizing helper was a nonblocking maintenance observation.
- **P2, corrected:** snapshot activation checked counts and checksums without comparing the index OIDs with canonical source membership. Activation now validates the complete sorted unique membership, bounded v2 structure, fanout and offsets. A different valid same-count pack is rejected through the HTTP entry point.
- **P2, corrected:** frozen manifest replay failed after later publication because current refs were checked before recognizing an existing immutable manifest. An existing matching identity now reuses its saved manifest. The retained E2E publishes, fetches and replays it successfully.
- **P2, corrected:** the one-time operator wrapper could skip native-service restart after a cleanup exception. Bounded SIGTERM/SIGKILL and nested cleanup now always attempt credential revocation and service restart, including database close failures. The native application worker had no additional concrete blocker in this review.

## Spec

- **P2, corrected:** the initial GitHub clone inherited HTTP and packet tracing variables. The real native-job fixture reproduced the issue; the clone now removes those variables before launching Git.
- **P1, corrected:** snapshot activation did not prove that the indexed objects belonged to this source inventory. The reviewer confirmed the membership, structure and replay fixes and found no remaining concrete blocker in the inspected changes. Streaming still reserves reads before returning and performs no SQL during body pulls.

The native one-click fixture also found that `fetch.unpackLimit=0` unpacked small received repositories. Setting it to `1` retains a native pack, and the full capacity-rejection, snapshot, clone/fsck and ref-equality workflow passes. The failed assumption remains in the evidence directory.

Validation: [78 passing HTTP/CLI/native tests](source-snapshot-final-suite.txt), [snapshot cases](source-snapshot-final-e2e.txt), [one-click capacity fallback](native-snapshot-fallback-green.txt), [types](source-snapshot-typecheck.txt) and [Worker build](source-snapshot-build.txt). These were the local checkpoint checks; the later independent large production verification is now complete in `private-verification.json`.

Summary: Standards recorded three correctness findings, all corrected (worst P2), plus one nonblocking maintenance observation; Spec recorded two findings, both corrected (worst P1).

## Native blame correction review

The independent verifier found six incorrect empty-line origins. Both review axes inspected the new comparator against retained upstream Git v2.50.1 source, the metadata parent ordering and bounded second-parent rename discovery. Standards found zero documented violations or actionable smell findings; Spec found no concrete correctness blocker. The existing rename similarity remains a matching-line byte approximation, not a claim of universal Git diffcore parity. Static review did not run additional production calls.

The corrected behavior passed 84 tests, including 134 native differential pairs and HTTP regressions for newline identity, blank-line history, identical second-parent files and renamed second-parent origins. Only blame caches advance to version 2; immutable source caches remain reusable.

## Final branding, media and acceptance review

Baseline: `9181726e07b015e2193f5cc857f4db55e1c315d0`; command `git diff 9181726` plus new relevant files. No later commits were present at review time. The two axes ran independently and made no provider calls.

### Standards

No documented-standard violations or actionable heuristic concerns. The wordmark regression was recorded before implementation; five UI tests pass with Adobe Latin/system CJK proof and failure fallback. Brave uses an isolated profile. Capture is bounded to 4,000 frames and retains 2,046 timed frames. Cost reporting keeps reservations, observations and estimates distinct. **New findings: 0.**

### Spec

No actionable findings. The image contains five sharks and the wordmark is `squa.li`. All 20 original criteria and six mandatory items are unchanged; their bounded evidence supports completion. The private semantic sample is correctly distinguished from full exported object/ref equality. The 410.2-second video includes the final report and audible narration in every scene. Unmet latency targets and scope limits remain explicit. **New findings: 0.**

Summary: final Standards 0 and Spec 0. This review supports the fixed checklist, not universal Scion parity or a performance ranking. Five decoded frames and the final PCM audio report were inspected before release.

## Apache replacement and final production supplement

A final rules check found that the experimental LGPL comparator was not eligible under the competition's source-license requirement. It was replaced with an independently Apache-2.0 licensed imara-diff adaptation, retaining attribution and its complete license. The first replacement exposed one blank-separator origin regression; a minimized failing native test preceded the fix. Final checks: 135 native differential pairs, 84/84 full tests, typecheck/build and isolated v4 blame caches. The live response matches 75 full commit origins and seven native original-line regression points. The earlier complete native verification and video remain historical evidence; the replacement has its own supplement.

### Standards supplement

Zero new implementation violations. One P2 publication concern was corrected: full third-party README text is omitted from public blame captures, which now retain only comparison identities, raw-capture hashes and limited screenshot context. The original captures are private. No tokens or cookies appear in public network evidence. Earlier failed Azure inspection is not represented as passing.

### Spec supplement

Two minor stale-document findings were corrected: performance now links completed private verification/reconciliation, and current-suite links point to the Apache final run. Production timing remains one 20.995-second observation, without a speedup claim. No new implementation blocker was found. Release publication is verified separately.
