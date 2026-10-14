# Competition submission material

**Draft: final private-import acceptance and a current continuous video are still required. No competition entry has been submitted.**

## Project

**Squali — source control for parallel agents.**

Live application: https://squa.li

Open-source repository: https://github.com/gridheap/squali

License: MIT

## Vision

Agents can create changes through an authenticated API without cloning a repository. Squali keeps each immutable change with its intent, evidence and dependencies. People approve exact revisions, select compatible changes, resolve conflicts and publish a single main update. Source queries, sparse clients and a shared node cache let jobs fetch only the data they need.

Squali follows Anthropic's public Scion design: independent incremental changesets, content-addressed blobs, server-side source operations, derived indexes and separate publication. Git interoperability remains available through Cloudflare Artifacts. The acceptance checklist describes coverage of that published design; it is not certification or a claim of access to Anthropic's internal implementation.

## How it uses Cloudflare

Workers serves the application and authenticated source APIs. R2 holds authoritative compressed blobs addressed by SHA-256. PostgreSQL through Hyperdrive holds canonical changesets, indexes, identities, reviews, journals and persistent usage budgets. A changeset stores first-parent file deltas and does not require a proposal ref. Publishing approved changes separately updates the main ref with compare-and-swap.

Artifacts provides a derived Git compatibility repository for native clone and fetch. Independent source reads and proposals do not depend on that copy, and source import can finish when the Git provider's repository-size limit prevents an export. A separate R2 bucket caches disposable Git compatibility objects. Existing source objects are reused across resumed jobs, and unknown upload acknowledgements are reconciled by immutable identity.

Clerk handles GitHub sign-in. A connected user's authorized private repositories can be queued from the catalog. A bounded native consumer on an existing Azure VM downloads an input once, persists its journal, ingests objects in batches and seeds the Git compatibility copy. Only one job runs at a time; failures require explicit recovery. There is no D1 or application Durable Object.

## Demonstrated workflows

- Concurrent source changes, exact-version review and selected batch publication.
- Server-side diff, merge, continuous rebase with conflict recovery, revert and executable first-parent bisect.
- Commit graph skip pointers, ancestry/merge-base, indexed path history and blame.
- Sparse writable clients with restart recovery and a shared Unix-socket daemon.
- Actual Linux FUSE lazy reads, verified cache snapshots and failure isolation.
- Directory-scoped credentials and explicit JS/JSON semantic review policies.
- Git clone/fetch, native object identity and lost-acknowledgement recovery.
- Production GitHub login and private repository discovery; full large-import acceptance remains pending.

## Reproduction and evidence

Follow [README](../README.md) and [source operations](source-operations.md). Local development defaults to the source store and needs PostgreSQL, Git, Python 3 and the pinned Node/pnpm toolchain. Fixture tokens are separate from production credentials.

Run `node --import tsx --test tests/*.test.ts` for the complete API/CLI suite. The current retained report has [67 passing tests](evidence/2026-10-15-source/derived-full-e2e.txt). Rendered workflow, mobile, font-loading fallback, actual glyph provenance, native FUSE and failure/recovery evidence are indexed in [the evidence guide](evidence/2026-10-15-source/README.md).

[Performance evidence](performance.md) separates current source results from earlier Git-adapter results. A production 64-change/8-client sample and an eight-change optimization follow-up are retained, including unfavorable latency and initial authorization failures. Different batch sizes are not a controlled speedup comparison. [The source budget](source-import-budget.md) distinguishes provider metrics, application reservations and ongoing Azure/storage costs.

## Remaining acceptance gates

The private fixture contains 421,219 objects, 85,563 commits, 1,020 refs and 8.33 GB of raw history, with a 324.6 MB Git pack. Its existing native cache passed fsck. Source ingestion is still running. The final verifier will compare all exported objects and refs, native fsck, source tree and selected history/blame results against that frozen cache, using one retained clone and a bounded API journal.

The fixed Scion checklist requires 19 of 20 fully verified items and all mandatory architecture gates. Tree, generation, graph and path results share the same versioned dependency engine, with bounded vectorized adapters and retained eager/lazy reconstruction evidence. FUSE is read-only; changes use the sparse client or API. Text editing, graph queries and Git bridge exports have documented budgets. See [readiness](readiness.md) and [capability boundaries](scion-parity.md).

A **continuous 5–10 minute demonstration of the accepted current version is still required**. The old v0.1.0 video predates the source architecture and must not be used as the final submission video.

## Human submission

The [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) prohibit robotic, programmed or automated entries. After all acceptance gates pass, an eligible team member must personally review and submit the [entry form](https://www.cloudflare.com/git-competition/submit/), supplying their own contact information and required confirmations.

Deadline: October 14, 2026 at 11:59 p.m. PDT, equivalent to **October 15 at 14:59 in Taipei**. Preparing this package is not a submitted entry.
