# Source architecture acceptance, 2026-10-15

This is intermediate evidence. The fixed Scion checklist and the full private import are not yet complete; the competition has not been submitted.

## Reproducible commands

- `node --import tsx --test tests/source.test.ts`: HTTP/native Git authority, resumable import, binary transport, interrupted writes, canonical rebuild, raw RPC, regional cache, eager graph, path history, legacy encoding and historic tree modes. Individual red/green transcripts are retained here.
- `node --import tsx --test tests/node-cache.test.ts`: real Unix socket daemon, 12 concurrent clients, one source read, snapshot restore, credential separation and failed-read cooldown.
- `node --import tsx --test --test-concurrency=4 tests/*.test.ts`: `full-api-e2e.txt` records 48 passing tests at that checkpoint. Later additions have targeted transcripts; the final complete-suite run is still pending.
- Linux: `SQUALI_PROJECT=scion-source-pilot python3 tests/fuse-e2e.py --work /var/tmp/squali-fuse-acceptance`. `fuse-green-attempt.json` contains the first cold two-mount content pass (2,275 ms, two content objects), which also exposed an xattr warning. After fixing the warning, `fuse-green.json` records the exact `--reuse-cache` invocation, 1,284 ms for two mounts, no additional object fetches and empty stderr. The worker/domain is real; no Linux mount is simulated. Required authentication stays in `SQUALI_TOKEN`.
- `python3 scripts/import-source.py PROJECT EXISTING_GIT_REPOSITORY --state PRIVATE_STATE_DIRECTORY`: resumable native importer. Explicit object, byte, request, per-invocation batch and time ceilings are described in `docs/source-import-budget.md`.

## Production checkpoints

- `production-pilot.json`: 8 objects, 2 commits, annotated tag, native tree equality, 3 R2 source write reservations and no additional Artifacts calls.
- `private-pilot.json`: 2,048 objects / 41,511,548 raw bytes admitted from the existing private-fixture cache. 829 new content write reservations; 43 HTTP attempts including preflight and batches. Full source inventory: 421,219 objects, 8,332,097,572 raw bytes. The initial preparation plus pilot took 113.667 seconds.
- The next continuation stopped at cursor 5,248 on a historic `100664` tree mode. `historic-mode-red.txt` reproduces the exact original Git tree; `historic-mode-green.txt` verifies compatible reads and byte-exact rebuilding. Latin-1 metadata and file/directory transitions have separate regression evidence. Successful earlier objects are reused.
- Source R2 bucket: `squali-source`, Standard, WNAM. Its only default lifecycle rule aborts incomplete multipart uploads; completed source objects do not expire. R2 analytics initially lagged and reported zero objects, so application reservation counts are explicitly distinguished from provider billing.
- Production Worker version `26a3182a-69d9-4063-be05-07057c223110` includes the historical-mode, raw metadata, eager graph and path-index fixes. The latest `indexes` rebuild endpoint is local pending the next deployment.

## Boundaries still open

The FUSE mount is currently immutable/read-only; writable edits use the existing working-copy client and HTTP change workflow. The new source authority has no full native Git export yet. A production native job runner for one-click GitHub source imports remains to be connected. The large private import, final UI/font checks, complete load/cost comparison, and other fixed-checklist items remain open. None of these are counted as complete by this evidence.
