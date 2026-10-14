# Original goal and submission readiness

**Not ready for final submission. Full Scion parity is not complete.** The goal is an online source-control service with strong performance and cost efficiency, using Workers, Artifacts and R2, without D1. The [Scion capability map](scion-parity.md) is the acceptance boundary.

## Verified at the latest checkpoint

- Canonical changesets with first-parent deltas, independent compressed R2 blobs, separate CAS publication and no proposal refs. Git trees/commits can be reconstructed from canonical data.
- Source authority, native import, Git clone/fetch and recovery, single/continuous rebase, semantic review, automatic bisect, graph/path indices, directory IAM, sparse working-copy recovery and cache isolation have retained E2E evidence. The latest complete API/CLI suite has **62 passing tests**.
- Real Linux FUSE performs lazy content reads through the node socket; two mounts share a cache. Metadata inspection fetches no file bodies. Verified snapshots and failure isolation are tested. Mounts remain read-only; writable operations use the sparse client/API.
- The persistent native GitHub consumer runs on the existing Azure VM. It admits one active job, retains Git/input journals, continues healthy checkpoints, and never automatically restarts a failed job. Browser fixture tests cover login/catalog/private import, pause/resume and owner isolation.
- Source-backed rebase, semantic approval and Git export work with a single database connection. Export transfers do not hold database transactions. A slow export does not block another workspace or allow duplicate export.
- Local 64-change/8-client source sample: 318.19 changes/s, p95 95.93 ms, zero new blob writes during publication. These are local measurements, not cloud throughput. Batch sealing 128 commits uses 18 SQL queries versus the earlier 1,793.
- Mobile UI, workflow, failure fallback and warm Adobe glyph selection have saved browser evidence. Cold Adobe CSS exceeded its 2.8-second budget in one run; fallback remained stable. Warm Proxima Nova Latin and platform PingFang SC CJK were confirmed through CDP.
- Latest Worker: `f5e53d14-c978-4137-b411-d9320e94e87f`, at https://squa.li. The legacy workers.dev and preview URLs remain disabled. Source R2 objects have no expiry; disposable cache objects expire after seven days. No D1 or application Durable Object.

## Still required before submission

1. Finish and independently verify the private fixture: 85,563 commits, 1,020 refs, 421,219 objects and 8.33 GB raw data. Source fsck passed. Ingestion recovered its one uncertain blob through a retained native cache/journal and is advancing past 118,912 objects. Do not reset the three older legacy attempts or repeat the GitHub clone.
2. Finish the private workspace end-to-end verification after import. Real production GitHub login and repository discovery now pass: 97 authorized repositories are listed, and the retained private job is visible as running. No new whole-repository transfer was triggered for this browser check.
3. Finish final object/ref/native-Git comparisons and cost reconciliation. A real 64-change/8-client cloud sample and a smaller post-optimization smoke are retained. Reconcile provider metrics with application reservations; account for Azure capacity and ongoing storage.
4. Reconcile every fixed Scion checklist item and its explicit limits. Generic derivation exists, while graph/path bulk builders remain specialized. Do not count partial work as complete.
5. Record a continuous current-version demonstration, review the final package, then have the eligible team member submit the competition entry.

The competition asks for Workers, Artifacts, concurrent agent changes, an open-source license, runnable instructions and a 5–10 minute video. Its format requirements do not by themselves establish product readiness. No submission has been made.

Sources: [article](https://www.anthropic.com/engineering/redesigning-source-control), [competition](https://www.cloudflare.com/git-competition/), [rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).
