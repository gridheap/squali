# Acceptance status

**Competition submission remains paused at the user's request. No entry has been submitted.** The public Scion design is the implementation reference. A local capability checklist is not evidence of “95% Scion,” its fleet-scale results or competition readiness.

## Latest accepted work

- **Recoverable virtual-workspace rebase:** the server merges dirty edits onto an immutable target; the same Linux workspace switches between durable overlay generations. The complete tree matches native Git. Conflicts, explicit resolution, cancellation, lost acknowledgements, changed retry input and process interruption on either side of the atomic switch pass. [Usage](virtual-workspaces.md) · [evidence](evidence/2026-10-15-capacity/virtual-rebase-result.json).
- **89 passing regression tests**, plus real Linux virtual-workspace and separate CPU/capacity acceptance. Typecheck and Worker build pass. [Exact commands and results](evidence/2026-10-15-capacity/README.md).
- **Actual workerd and eight node processes:** a 4,097-file/129-commit local fixture covers 128 concurrent readers, longer cache phases, 768 proposals and 12 publications. CPU, RSS, regional JS heap, failed attempts and storage operations are recorded separately. [Results and recommended concurrency](capacity.md).
- **Production rebase API:** source Worker `33af85df-5716-4900-a00a-239dbbb6525f` on [squa.li](https://squa.li). Five bounded verification requests pass, with unchanged main and no additional source read/write reservations. The regional Worker remains `c71c1cbb-4e09-418f-bfa9-e0f850862fe4`. Workers.dev/previews remain disabled. No D1 or application Durable Object.
- **Retained large private import:** 421,219 original objects, 85,563 commits, 1,020 refs and 8.33 GB raw history. All exported objects/refs match native Git and fsck passes. Eight canonical deltas and bounded history/blame samples match. No repeated import or verification clone was needed for this checkpoint. [Original audit](evidence/2026-10-15-source/private-verification.json).
- **Existing product flows:** the previously verified Clerk/GitHub private import, owner isolation, source/history/blame and reviewed publication remain covered by regression evidence. The five-shark brand and Adobe/system-CJK behavior were not redesigned during this backend/client change. [Prior rendered acceptance](evidence/2026-10-15-source/private-browser-acceptance.md).
- **Current provider accounting:** month-to-date source/regional CPU, R2 operations/storage and application reservations are reconciled through October 15, 11:39 UTC. Historical failures and one rejected analytics credential remain recorded. [Current accounting](capacity.md#storage-calls-and-cost).

## Remaining limits

The in-place operation requires pausing the running workspace command; it does not change the filesystem underneath an active build. Source edits remain bounded regular UTF-8 files. Binary/symlink objects are preserved during import, but arbitrary edits to them are not supported. Snapshots are refreshed explicitly, not by an installed periodic fleet service.

The new measurements are local, with real workerd and PostgreSQL but a disk R2 adapter. Cross-region throughput, long-duration production percentiles, provider isolate peak memory, a production fleet hit rate above 99% and a controlled Git infrastructure comparison remain unmeasured. The latest retained production proposal p95 is still 3.369 seconds and cold README blame observation 20.995 seconds; a separate successful warm rebase observation does not replace those results.

Artifacts' 1 GB repository limit required a verified R2 compatibility snapshot for the large import. Its 500,000-object / 512 MiB pack / 16 MiB index bounds remain explicit. PostgreSQL has not demonstrated Spanner-scale throughput. Full-text code search and automatic CI are not implemented. [Scion work remaining](scion-next.md).

The earlier v0.2.0 capability score and competition package are historical artifacts. They do not override the user's requirement to withhold submission until the intended effects and complete acceptance are achieved.
