# Node cache and filesystem acceptance

The source RPC is an authenticated POST to `/api/projects/:id/rpc`, with `head`, `object` or `stat` operations. Object responses contain raw Git-compatible bytes and immutable identity headers. The node daemon relays the same request and response over a private Unix socket. The virtual filesystem uses this socket; it has no direct authority fallback. Scoped credentials cannot use arbitrary object access.

The node daemon has one bounded cache, merges simultaneous misses, verifies object hashes before caching, checks workspace authorization with a short lease, and applies an error cooldown. Snapshots contain bounded, checksum-verified cache data and are refreshed explicitly. No recurring job is installed.

Failure specification before implementation: corrupt or truncated objects; shared-cache tenant escape; revoked credentials; duplicate concurrent misses; authority or daemon outage causing a bypass; inode size/mode/content differing from native Git; stat/readdir fetching file contents; interrupted reads; cache size growth; forged/truncated snapshots; snapshot restore making new origin reads for retained objects. Acceptance uses real HTTP, Unix sockets and native filesystem commands on Linux FUSE. A CLI hydration command is insufficient evidence of a virtual filesystem.
