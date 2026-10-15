# Writable virtual workspaces on Linux

`scripts/virtual-workspace.py` composes the shared node daemon, a read-only FUSE source mount and Linux OverlayFS. Source files are hydrated only when read or copied up. Local edits live in a fixed-capacity ext4 image; a process restart does not discard them. An explicit proposal sends the changed files through the existing source API.

Prerequisites: Linux with `/dev/fuse`, `fusermount3`, OverlayFS, loop devices, `mkfs.ext4`, `unshare`, Python 3 and mount capability. The launcher currently runs as root in a private mount and process namespace. Run it on a dedicated trusted worker/container; it is not a sandbox for hostile commands. A typical desktop without Linux mount capability should use the existing sparse client.

Start the [node daemon](node-cache.md) with a whole-workspace credential. Its private socket is the only read path; the virtual client has no direct source-read fallback. `SQUALI_TOKEN` for `propose` is a separate environment credential checked by the server.

```sh
sudo --preserve-env=SQUALI_URL,SQUALI_TOKEN python3 scripts/virtual-workspace.py run \
  --socket /run/squali/node.sock --project PROJECT --ref IMMUTABLE_COMMIT \
  --state /var/lib/squali/workspaces/task-one --seconds 900 -- sh

sudo python3 scripts/virtual-workspace.py status \
  --socket /run/squali/node.sock --state /var/lib/squali/workspaces/task-one

sudo --preserve-env=SQUALI_URL,SQUALI_TOKEN python3 scripts/virtual-workspace.py propose \
  --socket /run/squali/node.sock --state /var/lib/squali/workspaces/task-one \
  --id update-client --title 'Update the client'
```

The command runs with the virtual root as its working directory. Its process group is stopped when it exits or exceeds its lifetime. The mount is then removed; its private state remains. Background services should run outside this command group. Linux also kills remaining descendants when the private process namespace exits, including after the launcher is forcibly killed. Failed unmounts preserve data and report their paths instead of recursively deleting a live mount.

## Limits and recovery

- One active command or proposal per state directory, enforced by an exclusive lock.
- State stays pinned to its project, current immutable base and service origin. Reopening with an arbitrary different `--ref` is rejected. Use the explicit rebase operation below to advance the same workspace while preserving dirty edits.
- Default overlay capacity is 256 MiB; choose 32 MiB–1 GiB at initialization. This is the fixed filesystem-image capacity, including filesystem metadata. Kernel ENOSPC enforces it. Changing the flag later does not resize it.
- Default command lifetime is 900 seconds; allowed range 1–3,600 seconds.
- Proposals allow 64 changed regular UTF-8 files, 256 KiB per file and 1 MiB total content. Binary writes may exist locally but cannot yet be submitted. Symlinks, submodules and file/directory replacements require explicit native handling.
- Change inspection visits at most 10,000 upper-layer paths and 4,096 source trees. It compares upper-file hashes with immutable source metadata, so untouched file bodies are not fetched for status/proposal.
- Deleting and recreating a directory removes absent children while preserving any recreated identical files. Invalid proposal titles are rejected before creating a pending journal.
- Before sending a proposal, the exact payload is fsynced into a private pending journal. After a lost response, retry the same ID and title; the saved payload is reused even if local edits have changed. There are no automatic retries. A confirmed receipt is saved atomically and a repeated accepted operation makes no network call.
- Receipt replay does not mean that later local edits were included. The immutable base and current upper layer remain explicit; status shows current changes relative to that base.
- Credentials are not saved in the manifest or journals. Payload journals contain private source text and require the same protection as the working copy.

## Reproducible acceptance

On the development Mac with the existing Colima VM, local PostgreSQL and pinned Node runtime:

```sh
node --import tsx tests/virtual-workspace.e2e.ts
```

The test starts the real local source API and regional RPC tier, then uses actual Linux mounts and ordinary filesystem commands. It also drops an accepted HTTP response to verify recovery. [Stored result](evidence/2026-10-15-regional/virtual-workspace-result.json). This is a local integration result, not a fleet-scale performance claim.

## Rebase the same workspace

Stop the running workspace command, then use an immutable target commit:

```sh
sudo --preserve-env=SQUALI_URL,SQUALI_TOKEN python3 scripts/virtual-workspace.py rebase \
  --socket /run/squali/node.sock --state /var/lib/squali/workspaces/task-one \
  --id advance-task-one --onto TARGET_COMMIT
```

The server performs the three-way merge of the old base, target and local changed files. Planning creates no proposal, source blob or published ref. The client writes only the returned changed files into a new overlay; the target remains an on-demand FUSE lower layer. It does not fetch untouched working-tree bodies. Reopen with `run` and the same state directory; omit `--ref` or supply the new target. `status` and `propose` now use that target as the base. An explicit proposal still requires review before publication.

The exact input is saved before HTTP. A pending rebase blocks `run` and `propose`; `status` can still inspect the preserved original state. Retry the same ID and target after a lost response. There are at most **eight explicit plan requests per operation**, with no automatic retries. Once a plan is saved, staging recovery does not recompute it. An accepted receipt can be replayed offline; changed targets or explicit resolutions are rejected for that ID.

Conflicts return `rebase_conflict` and retain all three versions in the private `rebase.json` journal. Supply a JSON array of `{path,content,mode?}` to resolve the conflicted paths:

```sh
sudo --preserve-env=SQUALI_URL,SQUALI_TOKEN python3 scripts/virtual-workspace.py rebase \
  --socket /run/squali/node.sock --state /var/lib/squali/workspaces/task-one \
  --id advance-task-one --onto TARGET_COMMIT --resolutions /private/resolutions.json

sudo python3 scripts/virtual-workspace.py abort-rebase \
  --socket /run/squali/node.sock --state /var/lib/squali/workspaces/task-one \
  --id advance-task-one
```

Cancellation preserves the original image and edits. IDs remain reserved after cancellation. If the atomic switch already completed, recovery finishes that operation and returns its receipt; it does not roll back later edits.

Both images are unmounted and the staged image is fsynced before the manifest is atomically replaced. Recovery therefore selects a complete old or new generation. The old image is removed only after the new manifest and receipt are durable. Staging needs up to **twice the configured image capacity**, plus bounded text journals; at most one staging generation exists. Interrupted staging is rebuilt from its saved plan. Retired images do not accumulate. This handles process interruption; storage hardware must honor fsync for power-loss durability.

Rebase retains the existing editing limits: 64 regular UTF-8 files, 256 KiB per file, 1 MiB of edits and 2 MiB of three-way comparison data. Binary files, symlinks and file/directory replacements are rejected before changing the active generation. Empty directories are not source objects and are not preserved by rebase. Resolve uncertain pending proposals before starting a rebase.

`node --import tsx tests/virtual-rebase.e2e.ts` verifies the complete resulting tree against native Git, conflict/abort/resolution, lost response, frozen inputs, zero client blob fetches during rebase, changed receipt input, and process exit immediately before/after the atomic switch and during cancellation. [Current result](evidence/2026-10-15-capacity/virtual-rebase-result.json).
