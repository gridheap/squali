# Squali

[Live application](https://squa.li) · [Demo video](https://github.com/gridheap/squali/releases/download/v0.1.0/squali-demo.mp4) · [Source](https://github.com/gridheap/squali)

**Source control for parallel agents.**

Squali is an open-source collaboration prototype for the Cloudflare Git competition. Agents propose immutable changes with intent, context, evidence and dependencies. Reviewers inspect them, reconcile overlapping edits and publish compatible changes in one atomic Git update.

Cloud deployment: **Cloudflare Workers + Artifacts + PostgreSQL through Hyperdrive**. No D1. No application Durable Objects. The local development adapter uses real PostgreSQL and Git's HTTP backend, so the complete workflow runs without cloud credentials or billable calls.

The deployed integration passed real Artifacts publication, authenticated native Git clone and `git fsck`. [Verification evidence](docs/evidence/) separates local benchmarks from cloud smoke results.

## Run locally

Prerequisites: Node.js 24+, pnpm, Git and PostgreSQL 17+. The repository pins Node 24.21.0 and pnpm 11.25.0 using mise. Do not install browsers to run the API tests.

```sh
pnpm install
bash scripts/setup-local.sh
pnpm dev
```

Open http://127.0.0.1:8787. Connect with `local-admin-test-token` to review and publish, or `local-agent-test-token` to propose changes. These are local fixtures, never production credentials. The server binds to loopback only. Set `DATABASE_URL` to use your own local PostgreSQL; the default is `postgres://weave@127.0.0.1:55439/weave`.

1. Create a workspace.
2. Submit changes from the UI or the agent API.
3. Review intent, context and the before/after diff. Approve an immutable version.
4. Preview the approved batch. Compatible line edits reconcile automatically; conflicts require a revision and new approval.
5. Publish. Git checks the expected old head, and PostgreSQL records the durable publication.
6. Read the source and publication history. Use the authenticated `/api/projects/<id>/git` gateway for ordinary Git clone/fetch with a Squali token.

## Agent API and CLI

No model provider, token subscription or agent framework is required. Any agent that can call HTTP can participate.

```sh
export SQUALI_URL=http://127.0.0.1:8787
export SQUALI_TOKEN=local-agent-test-token
node scripts/squali.mjs propose my-project < change.json
```

Example `change.json`:

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

Evidence is supplied by the agent; Squali does not execute or certify those commands. Reviewers remain responsible for assessing it.

CLI commands: `projects`, `create`, `changes`, `propose`, `show`, `review`, `revise`, `preview`, `publish`, `events`, `file`, `tree`, `usage`. Mutations read JSON from stdin. Tokens are environment variables, not command arguments. See [the API contract](docs/api.md).

## Verification

```sh
pnpm typecheck
pnpm test:e2e
pnpm build
BENCH_CHANGES=32 BENCH_CONCURRENCY=8 pnpm benchmark
```

API E2E tests start isolated schemas and Git repositories and use real HTTP. They cover concurrency, role authorization, immutable review, conflicts and revisions, dependency ordering, native Git interoperability, external pushes, executable modes, operation caps, cache authorization, acknowledgement loss, and cancelling an unpublished batch. They leave a reproducible fixture under `work/e2e-*`.

Browser tests use an installed Brave browser and an isolated profile. Start `pnpm dev`, then run `pnpm test:ui`. Change `launchOptions.executablePath` in `playwright.config.ts` for an existing browser on another platform. Do not download a browser automatically. Both desktop and mobile views are exercised, alongside successful Adobe font loading, correct Latin/CJK glyph provenance, and bounded fallback under network failure.

The included benchmark is local only. It measures 32 small independent changes against 64 baseline files with eight concurrent clients. It is not evidence of distributed scale or superiority to every Git platform.

## Design

- **Incremental Git writes:** construct only new blobs, changed ancestor trees and a commit; upload a valid Git pack directly. No clone, index or full working copy in the Worker.
- **Immutable proposals:** stable operation IDs and request hashes make retries repeatable. Source stays in Artifacts; intent, review and dependency metadata stay in PostgreSQL.
- **Shared reads:** immutable object caches are keyed by repository, object type and Git hash. Authorization runs before cache access. Branch heads remain uncached.
- **Batch publication:** a short per-workspace publication lock protects review state, and Git's expected-old-object check protects the branch against external writers. Agents can continue proposing while a batch publishes.
- **Recoverable publication:** persist the publication intent before pushing. If Git accepts the push but the acknowledgement is lost, retrying the exact operation finalizes its existing commit.
- **Bounded spending:** all Artifacts calls reserve from a persistent monthly cap before execution. Cache hits make no provider calls; failed and unknown outcomes consume the cap. No automatic paid retries, timers or scheduled jobs.

Read [architecture and tradeoffs](docs/architecture.md), [deployment](docs/deployment.md), [failure specification](docs/failure-spec.md), and [submission material](docs/submission.md).

## Explicit limits

This is a competition prototype, not a replacement for GitHub's entire product. Artifacts currently caps a repository at 1 GB. The editing API handles UTF-8 regular files; symlinks, submodules and binary blobs are retained by unchanged trees but cannot be edited through the API. Text merges are bounded and cannot establish semantic correctness. One main branch per workspace is the publication boundary. No automatic CI runner, global distributed load claim, offline worktree daemon, LSP, blame index, or directory-level IAM is included.

The UI is single-tenant per deployment, with project-scoped bearer principals. Use separate author and reviewer identities. Public installations should apply Cloudflare Access and appropriate request limits. Production tokens are never stored in browser storage.

## Fonts and license

The UI uses Adobe Proxima Nova and system CJK fonts. The configured Adobe project is authorized by the project owner; a new deployment must use its own licensed kit or set the kit empty for an explicit native fallback. No font files are bundled.

Source code: [MIT](LICENSE). Third-party dependencies retain their licenses. The project is independent of Anthropic and Cloudflare.
