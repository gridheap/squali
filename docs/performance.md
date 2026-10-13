# Bounded local performance comparison

Command: `pnpm exec tsx scripts/compare-git.ts`. Full report: [JSON](evidence/2026-10-14-acceptance/native-comparison.json).

Both paths start with 64 files (419,400 bytes), then 32 independent one-file changes with eight clients. PostgreSQL has five connections. Native Git uses eight reusable full clones and retained proposal branches, then one squash publication. Squali uses its normal authenticated API, journal, review and metering. Both final trees equal `d3c9183b8919adab49d3e680f7daeb6f7f809279`, contain 96 verified files, retain 32 proposal refs, and pass native `git fsck`.

| Measured phase | Squali | Native Git |
|---|---:|---:|
| Proposals/second | 49.91 | 34.89 |
| Proposal p50 | 152.34 ms | 207.16 ms |
| Proposal p95 | 181.73 ms | 299.52 ms |
| Proposal maximum / sample p99 | 182.78 ms | 317.95 ms |
| Batch publication | 454.29 ms | 1824.58 ms |

Native clone preparation took 402.8 ms, excluded from proposal timing. Squali review took 52 ms, also reported separately. Its publication pack was 2347 bytes for 32 changes. No cloud provider calls occurred.

This is one bounded local sample on an Apple M4 Max with 128 GiB RAM. With 32 observations, p99 is effectively the maximum. Bare Git does not provide Squali's identity, review or journal services. Results do not measure distributed workloads, contention, CPU/memory consumption, network egress or cloud cost per workflow. They cannot establish universal “highest performance” or “best value”.

The first comparison exposed dropped gzip negotiation on larger clones. The gateway now bounds compressed and expanded negotiation to 1 MiB. The retained failure and success reports document that fix.
