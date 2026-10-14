# Node cache and filesystem acceptance

The source RPC is an authenticated POST to `/api/projects/:id/rpc`, with `head`, `object` or `stat` operations. Object responses contain raw Git-compatible bytes and immutable identity headers. The node daemon relays the same request and response over a private Unix socket. The virtual filesystem uses this socket; it has no direct authority fallback. Scoped credentials cannot use arbitrary object access.

The node daemon has one bounded cache, merges simultaneous misses, verifies object hashes before caching, checks workspace authorization with a short lease, and applies an error cooldown. Snapshots contain bounded, checksum-verified cache data and are refreshed explicitly. No recurring job is installed.

Failure specification before implementation: corrupt or truncated objects; shared-cache tenant escape; revoked credentials; duplicate concurrent misses; authority or daemon outage causing a bypass; inode size/mode/content differing from native Git; stat/readdir fetching file contents; interrupted reads; cache size growth; forged/truncated snapshots; snapshot restore making new origin reads for retained objects. Acceptance uses real HTTP, Unix sockets and native filesystem commands on Linux FUSE. A CLI hydration command is insufficient evidence of a virtual filesystem.

## Run the node and mount

Set `SQUALI_URL` and a whole-workspace `SQUALI_TOKEN` in the environment. The Unix socket is private to the current user; keep the cache directory private too. In one terminal:

```sh
python3 scripts/node-daemon.py --socket /tmp/squali-node.sock \
  --cache /path/to/private-cache --max-bytes 1073741824
```

On Linux with an existing `/dev/fuse` and `fusermount3`, use another terminal:

```sh
mkdir /path/to/empty-mount
python3 scripts/squali-fuse.py --socket /tmp/squali-node.sock \
  --project PROJECT --mount /path/to/empty-mount --ref IMMUTABLE_GIT_COMMIT
```

Ordinary `ls` and `stat` read tree/size metadata; `cat` and compilers opening a file hydrate its verified body. The mount pins one immutable commit. It admits 100,000 inodes by default, 128 open handles and 64 MiB resident file bodies. Submodule links appear as empty directories; fetching another repository is explicit. Unmount with `fusermount3 -u /path/to/empty-mount`. Use the [sparse working-copy client](working-copy.md) to edit and propose changes.

The framed Unix protocol uses a four-byte big-endian JSON request length, then a request such as `{ "project":"PROJECT", "op":"object", "oid":"..." }`. Responses contain a length-prefixed metadata object followed by the declared body length. `stats` exposes local counters. `snapshot` with a safe `name` creates a checked SQLite snapshot and JSON manifest under the cache directory. Restore into a new empty cache with `--restore /path/to/snapshot.sqlite`; both its namespace and content checksums must match. Do not copy snapshots across credentials.
