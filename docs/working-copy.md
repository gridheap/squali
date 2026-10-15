# Sparse working copies

Use the same authenticated API as an agent. Set `SQUALI_URL`, `SQUALI_TOKEN` and optionally `SQUALI_CACHE_DIR` in the process environment. Credentials are never saved in the working copy.

```sh
node scripts/working-copy.mjs checkout my-project work/task-one src docs/guide.md
node scripts/working-copy.mjs hydrate work/task-one tools/check.sh
node scripts/working-copy.mjs add work/task-one src/new-file.ts
node scripts/working-copy.mjs status work/task-one
node scripts/working-copy.mjs watch work/task-one --seconds 60 --max-events 10000
node scripts/working-copy.mjs propose work/task-one update-client 'Update the client'
# After review/publication, update the clean working copy:
node scripts/working-copy.mjs update work/task-one
```

`checkout` requires a new directory. It fetches the current immutable head, traverses only selected trees, and materializes regular files. A second working copy can reuse the node's cached objects without cloning Git history. `hydrate` fetches more paths from the same frozen base. `status` and `propose` inspect tracked edits, deletions and executable modes. `add` explicitly tracks new regular text files and rejects unseen existing remote paths. After a successful `propose`, the working-copy base advances to the server-confirmed commit. The proposal follows normal review/publication.

The local `.squali/manifest.json` records origin, workspace, base and file identities. Cached objects are namespaced by origin, workspace and permission scope, atomically written, and bounded to a 64 MiB target. Blob Git hashes are verified. A cache shared by trusted jobs is not an isolation boundary against another process with access to the same OS account. Each network-capable invocation validates its credential before cache reuse. The local `watch` command requires no token and makes no network requests. Narrow directory credentials use path-scoped APIs; warming an owner's cache does not grant a narrower token access.

Raw reads accept regular binary/text blobs up to 32 MiB. Editing accepts UTF-8 text up to 256 KiB/file and 1 MiB/change. Symlinks and submodules are rejected during materialization. Existing local changes are never overwritten. `update <directory> [commit-id]` downloads and verifies changed objects before applying a journaled update. It preserves hydrated selections, rejects dirty/untracked collisions, handles deletions and modes, and resumes after process death. A pending update must finish before another command; use one modifying process per working copy. Each update stages at most 256 MiB. This is not a virtual filesystem or a power-loss durability guarantee. Symlinks and submodules still require native Git.

Evidence: `pnpm test:sparse` verifies sparse paths, zero-object second checkout, executable hydration, local-change protection, proposal submission, and exact 2 MiB binary materialization. `pnpm test:permissions` verifies that a warm broader cache cannot bypass directory scope.

## Observe local filesystem changes

`watch` uses native directory notifications and emits newline-delimited JSON: an initial `ready` snapshot, coalesced `change` records, and a final `stopped` report. It detects existing edits, atomic replacements, deletions, executable-mode changes and new untracked files inside the selected paths. Unchanged files reuse their checked local identity. It never submits changes, implicitly adds files, saves credentials or fetches source. Use explicit `add` and `propose` afterward.

The default lifetime is 60 seconds; the maximum is one hour. A run admits at most 10,000 native events, 4,096 watched directories, 10,000 selected files, 200,000 metadata inspections and 256 MiB of content hashing. A tracked file is limited to 32 MiB. Notifications coalesce for 100 ms; initial and final reconciliation bound gaps. Symlinks are reported as unsupported and their targets are not read. A manifest/base change or filesystem error stops with exit 2 and `complete: false`; restart to reconstruct the current local state. Normal time/event limits close all watches and report the final observed state. As with any filesystem snapshot, edits made after it belong to the next observation.

`node --import tsx --test tests/working-copy-watch.test.ts` drives real checkout, filesystem edits and bounded process exit. It also pauses startup at the filesystem boundary, changes the base, and verifies that a stale base is never announced as ready. The saved event transcript records zero HTTP requests.

## Index an existing repository without uploading source files

```sh
node scripts/index-repository.mjs my-project /path/to/existing/repo <immutable-commit-id> --max-steps 20 --max-commits 10000
```

Use an unrestricted administrator credential. The CLI exports raw Git commit metadata in bounded batches; the server verifies object hashes and links to provider-confirmed repository history. It does not upload blobs, transfer the repository, or complete a failed Git import. An already completed index is reused. Defaults: 10,000 source commits and one index step; hard ceilings: 100,000 commits, 1,000 steps, 128 MiB of metadata and 15 minutes. An incomplete run exits with code 2 and retains server progress. Continue derivation through `POST /api/projects/:id/index`; re-exporting metadata is unnecessary after a successful upload. No automatic retries run.

## Writable virtual workspaces

The immutable FUSE source mount can now be combined with a bounded durable OverlayFS upper layer. See [virtual workspaces](virtual-workspaces.md) for real filesystem edits, explicit proposals, recovery, Linux requirements and acceptance evidence.
