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

Validation: [78 passing HTTP/CLI/native tests](source-snapshot-final-suite.txt), [snapshot cases](source-snapshot-final-e2e.txt), [one-click capacity fallback](native-snapshot-fallback-green.txt), [types](source-snapshot-typecheck.txt) and [Worker build](source-snapshot-build.txt). These local checks do not replace the pending large production verification.

Summary: Standards recorded three correctness findings, all corrected (worst P2), plus one nonblocking maintenance observation; Spec recorded two findings, both corrected (worst P1).
