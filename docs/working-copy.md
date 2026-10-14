# Sparse working copies

Use the same authenticated API as an agent. Set `SQUALI_URL`, `SQUALI_TOKEN` and optionally `SQUALI_CACHE_DIR` in the process environment. Credentials are never saved in the working copy.

```sh
node scripts/working-copy.mjs checkout my-project work/task-one src docs/guide.md
node scripts/working-copy.mjs hydrate work/task-one tools/check.sh
node scripts/working-copy.mjs add work/task-one src/new-file.ts
node scripts/working-copy.mjs status work/task-one
node scripts/working-copy.mjs propose work/task-one update-client 'Update the client'
# After review/publication, update the clean working copy:
node scripts/working-copy.mjs update work/task-one
```

`checkout` requires a new directory. It fetches the current immutable head, traverses only selected trees, and materializes regular files. A second working copy can reuse the node's cached objects without cloning Git history. `hydrate` fetches more paths from the same frozen base. `status` and `propose` inspect tracked edits, deletions and executable modes. `add` explicitly tracks new regular text files and rejects unseen existing remote paths. After a successful `propose`, the working-copy base advances to the server-confirmed commit. The proposal follows normal review/publication.

The local `.squali/manifest.json` records origin, workspace, base and file identities. Cached objects are namespaced by origin, workspace and permission scope, atomically written, and bounded to a 64 MiB target. Blob Git hashes are verified. A cache shared by trusted jobs is not an isolation boundary against another process with access to the same OS account. Each invocation validates its credential before reuse. Narrow directory credentials use path-scoped APIs; warming an owner's cache does not grant a narrower token access.

Raw reads accept regular binary/text blobs up to 32 MiB. Editing accepts UTF-8 text up to 256 KiB/file and 1 MiB/change. Symlinks and submodules are rejected during materialization. Existing local changes are never overwritten. `update <directory> [commit-id]` downloads and verifies changed objects before applying a journaled update. It preserves hydrated selections, rejects dirty/untracked collisions, handles deletions and modes, and resumes after process death. A pending update must finish before another command; use one modifying process per working copy. Each update stages at most 256 MiB. This is not a virtual filesystem or a power-loss durability guarantee. Symlinks and submodules still require native Git.

Evidence: `pnpm test:sparse` verifies sparse paths, zero-object second checkout, executable hydration, local-change protection, proposal submission, and exact 2 MiB binary materialization. `pnpm test:permissions` verifies that a warm broader cache cannot bypass directory scope.

## Index an existing repository without uploading source files

```sh
node scripts/index-repository.mjs my-project /path/to/existing/repo <immutable-commit-id> --max-steps 20 --max-commits 10000
```

Use an unrestricted administrator credential. The CLI exports raw Git commit metadata in bounded batches; the server verifies object hashes and links to provider-confirmed repository history. It does not upload blobs, transfer the repository, or complete a failed Git import. An already completed index is reused. Defaults: 10,000 source commits and one index step; hard ceilings: 100,000 commits, 1,000 steps, 128 MiB of metadata and 15 minutes. An incomplete run exits with code 2 and retains server progress. Continue derivation through `POST /api/projects/:id/index`; re-exporting metadata is unnecessary after a successful upload. No automatic retries run.
