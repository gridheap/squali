# Competition submission material

**Accepted implementation/package; human entry not yet submitted.** [Release v0.2.0](https://github.com/gridheap/squali/releases/tag/v0.2.0) · [410-second video](https://github.com/gridheap/squali/releases/download/v0.2.0/squali-source-demo.mp4) · [Form-ready text](entry-fields.md).

## Project

**Squali — source control for parallel agents.**

Live application: https://squa.li . Open source: https://github.com/gridheap/squali . Original code is MIT; the bounded line comparator uses Apache-2.0 imara-diff, with source, attribution and license included.

## Vision and architecture

Agents create immutable changesets through authenticated APIs without cloning a repository. Squali keeps each change with its intent, evidence and dependencies. People approve exact revisions, select compatible changes, resolve conflicts and publish a separate compare-and-swap main update. Source queries, sparse clients and a shared node cache let jobs fetch only what they need.

The architecture follows Anthropic's public Scion design: independent incremental changesets, content-addressed blobs, server-side source operations, derived indexes and separate publication. Its [fixed checklist](scion-acceptance.md) has 20 passing bounded criteria, clearing the ≥19 threshold and all six mandatory architecture gates. This is an engineering acceptance measure, not certification or a percentage of Anthropic's private implementation.

## Cloudflare usage

Workers serves the application and source APIs. R2 stores authoritative, independently compressed blobs addressed by SHA-256. PostgreSQL through Hyperdrive stores canonical first-parent deltas, indexes, identities, reviews, journals and persistent usage budgets. Proposals require neither Git refs nor Artifacts calls.

Artifacts provides the derived native Git compatibility copy. An explicit repository capacity rejection selects a bounded, verified R2 snapshot using the existing native pack. Native Git clone/fetch remains available for admitted snapshots. Source queries and changes remain independent of the compatibility copy. A separate R2 bucket caches disposable compatibility objects for seven days.

Clerk handles GitHub sign-in. Users queue their authorized private repositories from the catalog. The native consumer on an existing Azure VM downloads each input once and retains its journal. Only one job runs at a time; failed jobs require explicit recovery. Normal source APIs do not need the native input. There is no D1 or application Durable Object.

## Acceptance evidence

- Independent private fixture: **421,219 objects, 85,563 commits, 1,020 refs, 8.33 GB raw history**. Exported object/ref equality and native fsck pass. Root tree, README content/history/blame, graph queries and eight canonical deltas match native Git. A rejected proposal verifies writes without advancing main. [Exact result](evidence/2026-10-15-source/private-verification.json).
- **84 passing HTTP/CLI/native tests**, **five passing rendered browser tests**, typecheck/build, and real Linux FUSE lazy reads. [Evidence guide](evidence/2026-10-15-source/README.md).
- Production Clerk/GitHub login, private repository discovery and the completed workspace browser flow. [Screens and sequence](evidence/2026-10-15-source/private-browser-acceptance.md).
- Server diff/merge/rebase/revert/bisect; recursive derived data; graph skips; sparse writable clients and read-only FUSE; shared daemon/snapshots; directory IAM; explicit JS/JSON semantic constraints; selected publication and recovery.
- The final **6-minute-50-second continuous video** shows three concurrent scoped agent identities, exact review, selected publication, conflict resolution, blame, semantic checks and cost limits, then the retained production report. It is a real local source-service workflow, not a cloud load benchmark. [Media inspection](evidence/2026-10-15-source/demo-final/).

## Performance and cost

Latest bounded production sample: 2.301 proposals/s, p50 1.486 s, p95 3.369 s, eight-change publication 1.825 s. The two-second proposal target remains unmet. One private README blame takes 17.378 s. Local 64-change/eight-client throughput is 318.19/s and is explicitly local. Batch sealing 128 commits uses 17 SQL queries instead of 1,793. [Performance details](performance.md).

The final [cost reconciliation](cost-final.md) preserves provider metrics, reservations, prior failures, reporting lag and shared infrastructure exposure. Source R2 payload is about 2.2 GB. Existing shared Azure compute plus PostgreSQL storage lists about $65.95/month before disks/network/discounts; this is not Squali's marginal bill. No pending acceptance job or recurring backfill remains.

## Run and inspect

Follow [README](../README.md), [source operations](source-operations.md) and [entry fields](entry-fields.md). Use Node 24.21.0, pnpm 11.25.0, PostgreSQL 17+, Git and Python 3. Run `pnpm install --frozen-lockfile`, `bash scripts/setup-local.sh`, then `pnpm dev`. Local fixture credentials are documented separately from production secrets. Run `pnpm typecheck`, `pnpm test:e2e`, `pnpm test:ui` (with the local server running) and `pnpm build`.

## Human submission

The [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) prohibit robotic, programmed or automated entries. An eligible team member must personally submit the [official form](https://www.cloudflare.com/git-competition/submit/), supplying their own contact details and confirmations. Deadline: **October 15, 2026, 14:59 Taipei** (October 14, 11:59 p.m. PDT). No competition entry has been submitted by this repository or release.
