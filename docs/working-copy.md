# Sparse working copies

Use the same authenticated API as an agent. Set `SQUALI_URL`, `SQUALI_TOKEN` and optionally `SQUALI_CACHE_DIR` in the process environment. Credentials are never saved in the working copy.

```sh
node scripts/working-copy.mjs checkout my-project work/task-one src docs/guide.md
node scripts/working-copy.mjs hydrate work/task-one tools/check.sh
node scripts/working-copy.mjs status work/task-one
node scripts/working-copy.mjs propose work/task-one update-client 'Update the client'
```

`checkout` requires a new directory. It fetches the current immutable head, traverses only selected trees, and materializes regular files. A second working copy can reuse the node's cached objects without cloning Git history. `hydrate` fetches more paths from the same frozen base. `status` and `propose` inspect tracked edits, deletions and executable modes. The proposal then follows normal review/publication.

The local `.squali/manifest.json` records origin, workspace, base and file identities. Cached objects are namespaced by origin, workspace and permission scope, atomically written, and bounded to a 64 MiB target. Blob Git hashes are verified. A cache shared by trusted jobs is not an isolation boundary against another process with access to the same OS account. Each invocation validates its credential before reuse. Narrow directory credentials use path-scoped APIs; warming an owner's cache does not grant a narrower token access.

Raw reads accept regular binary/text blobs up to 32 MiB. Editing accepts UTF-8 text up to 256 KiB/file and 1 MiB/change. Symlinks and submodules are rejected during materialization. Existing local changes are never overwritten. This version does not mount a virtual filesystem, add untracked files automatically, or update a whole working copy to another head. Use native Git where those operations are required.

Evidence: `pnpm test:sparse` verifies sparse paths, zero-object second checkout, executable hydration, local-change protection, proposal submission, and exact 2 MiB binary materialization. `pnpm test:permissions` verifies that a warm broader cache cannot bypass directory scope.
