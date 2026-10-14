# Squali

[Live application](https://squa.li) · [Source](https://github.com/gridheap/squali) · [Acceptance status](docs/readiness.md)

**Source control for parallel agents.**

Squali implements the public Scion design as an online source service. Agents create immutable changesets with intent, context, evidence and dependencies. Reviewers reconcile changes and publish an approved selection with a separate compare-and-swap operation. Creating a changeset does not create or move a Git ref.

Cloud deployment: **Cloudflare Workers + R2 + Artifacts + PostgreSQL through Hyperdrive**. R2 holds independently compressed content-addressed blobs. PostgreSQL holds canonical changesets and workflow state. Artifacts provides a derived Git compatibility copy. No D1 or application Durable Objects are used.

**Under acceptance; not submitted.** The fixed [Scion capability map](docs/scion-parity.md), [source design](docs/source-architecture.md) and [retained evidence](docs/evidence/2026-10-15-source/) distinguish implemented features from outstanding production gates. Do not infer Anthropic's reported scale or speedups from this implementation. The earlier release video predates this architecture.

## Run locally

Prerequisites: Node.js 24+, pnpm, Git and PostgreSQL 17+. The repository pins Node 24.21.0 and pnpm 11.25.0 with mise. Python 3 is needed for native import, bisect and filesystem clients. API tests do not need a browser.

```sh
pnpm install
bash scripts/setup-local.sh
pnpm dev
```

Open http://127.0.0.1:8787. The local administrator credential is `local-admin-test-token`; the agent credential is `local-agent-test-token`. These fixtures are not production credentials. The server binds to loopback. Set `DATABASE_URL` to use an existing local PostgreSQL; the default is `postgres://weave@127.0.0.1:55439/weave`.

1. Create a workspace, then propose changes through the UI or API.
2. Review the immutable diff, intent and evidence. Approve the version you inspected.
3. Preview an approved selection. Compatible line edits reconcile; conflicts require a revision and new approval.
4. Publish against the previewed head. The durable journal and expected-head check protect concurrent writers and recover interrupted publication.
5. Use sparse source APIs or the authenticated `/api/projects/<id>/git` endpoint for native Git clone/fetch. Source-backed workspaces export only published refs and their reachable objects.

## Agent API and clients

Any agent that calls HTTP can participate; a model-provider subscription is not required.

```sh
export SQUALI_URL=http://127.0.0.1:8787
export SQUALI_TOKEN=local-agent-test-token
node scripts/squali.mjs propose my-project < change.json
```

```json
{
  "id": "retry-client-v1",
  "title": "Add a bounded retry client",
  "intent": "Retry transient failures at most three times. Keep the existing API.",
  "context": {"task": "SDK reliability", "evidence": [{"command": "node --test", "result": "pass"}]},
  "dependencies": [],
  "files": [{"path": "src/client.ts", "content": "export const retries = 3;\n"}]
}
```

Evidence is supplied by the agent. Squali does not execute or certify it. Reviewers assess behavior and evidence; optional semantic policy verifies specific JavaScript AST or JSON-value constraints.

- [HTTP API](docs/api.md): proposals, review, publication, diff, history, blame, ancestry, bisect, revert and single/continuous rebase.
- [Working copies](docs/working-copy.md): sparse materialization, edits, update and crash recovery.
- [Node daemon and Linux FUSE](docs/node-cache.md): shared object reads, checked snapshots and lazy read-only mounts.
- [Source administration](docs/source-operations.md): native ingestion, derivation, automatic bisect and a bounded cloud acceptance command.
- [Clerk and GitHub import](docs/github-import.md): owner isolation, repository consent, durable jobs and pause/resume.

Credentials are environment variables, not command arguments. Browser application code keeps tokens in memory; Clerk manages its own login session. Owners can issue expiring, revocable credentials limited to one workspace and optional directories.

## Verification

```sh
pnpm typecheck
node --import tsx --test tests/*.test.ts
pnpm build
BENCH_STORAGE=source BENCH_CHANGES=64 BENCH_CONCURRENCY=8 pnpm benchmark
```

API/CLI E2E starts real PostgreSQL and HTTP services with a persistent filesystem adapter at the R2 boundary. Native Git independently checks object, tree, history and publication results. Tests retain their exact commands and reports in the evidence directory. Production measurements are labelled separately from local benchmarks.

Browser tests use an installed Brave browser with an isolated profile. Start `pnpm dev`, then run `pnpm test:ui`. Configure an existing executable on another platform; do not download a browser automatically. Tests exercise desktop/mobile flow, font fallback and Latin/CJK glyph selection.

## Architecture

- **Canonical deltas:** immutable changesets identify parents and changed paths. Independently compressed R2 blobs are shared by content identity. Trees and Git commits are reconstructible compatibility data.
- **Separate publication:** proposals do not move refs. A short workspace publication boundary installs an approved selection; unrelated proposals and workspaces keep progressing.
- **Derived data:** versioned trees, graph generations, skip pointers and path events accelerate server operations. Bulk import seals parent-ordered changesets and indexes them in bounded SQL batches.
- **Sparse reads:** node daemon, Worker cache and source store expose the same immutable object protocol. Authorization precedes cache lookup. Linux FUSE fetches content when an ordinary tool opens a file.
- **Native import:** an existing Azure VM processes one PostgreSQL job at a time, retaining its Git cache and ingestion journal. Idle jobs use database notifications, with no paid HTTP polling.
- **Bounded cost:** persistent caps cover source R2, disposable cache and Artifacts separately. Failed and uncertain attempts count. Replay reuses confirmed data; a failed import does not restart itself.

Read [architecture](docs/architecture.md), [deployment](docs/deployment.md), [failure specification](docs/failure-spec.md) and [submission material](docs/submission.md).

## Explicit limits

Artifacts currently limits a repository to 1 GB; a larger source import remains usable through source APIs and explicitly reports Git compatibility unavailable. Native ingestion defaults to 500,000 objects, 16 GiB raw data and 12,000 HTTP attempts across restarts. These are admission limits, not measured scale claims. Editable files are UTF-8 regular files, at most 256 KiB each; binary objects, symlinks and submodules are preserved during import but are not edited through the text API. FUSE mounts are read-only; edits use the sparse client/API. One main branch is the publication boundary.

Continuous rebase handles up to 64 single-parent commits. Individual merge-commit rebase needs an explicit parent. Graph queries retain a 50,000-node budget. Specialized graph/path builders have not yet been unified into the generic derivation framework. Automatic CI, full-text code search and an Anthropic-scale distributed load test are outside the current implementation. See the readiness page for the live private-import and login gates.

## Fonts and license

The UI uses Adobe Proxima Nova and system CJK fonts. The configured Adobe project is authorized by the owner; other deployments need their own licensed kit or an explicit empty-kit native fallback. No font files are bundled.

Source: [MIT](LICENSE). Dependencies retain their licenses. Squali is independent of Anthropic and Cloudflare.
