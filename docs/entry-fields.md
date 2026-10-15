# Entry form text

**Accepted package; ready for the eligible team member to review and personally submit. No entry has been submitted.** [Acceptance and limits](readiness.md).

[Official form](https://www.cloudflare.com/git-competition/submit/)

## Project name

Squali

## Project vision

Agents should share small, reviewable changes without cloning a complete repository or creating a branch for every task. Squali gives each immutable change its original intent, context, evidence and dependencies. Reviewers approve exact revisions, keep approved work pending, and publish a compatible selection with one main update. Conflicts stop for an explicit resolution and fresh review.

Inspired by Anthropic's public Scion design, Squali separates changeset creation from publication. Server APIs answer source and history queries; sparse clients and a shared node cache fetch only needed objects. The project combines that architecture with private GitHub onboarding, directory permissions, semantic review constraints, restart recovery and persistent cost limits. Its open acceptance evidence distinguishes local results, production observations and documented limits.

## How you used Cloudflare

Cloudflare Workers serves the application, authenticated source APIs, review and publication. R2 stores authoritative compressed blobs by content hash and separately caches disposable Git objects. Hyperdrive connects Workers to PostgreSQL for canonical file deltas, derived indexes, identities, review records and durable job journals.

Cloudflare Artifacts provides the native Git compatibility copy for clone and fetch. If its repository capacity is explicitly exceeded, a verified, bounded R2 snapshot reuses the existing pack and preserves native Git access. Source changes are independent of proposal refs; publishing updates the source ref separately. A bounded native importer on an existing Azure VM retains its Git input and journal while uploading unique objects to Workers/R2 and seeding Artifacts. The node daemon and Worker cache reuse immutable objects with authorization and failure isolation. Separate persistent budgets cover source storage operations, disposable caching and Artifacts calls. The deployment uses no D1 or application Durable Objects.

## Open source repository URL

https://github.com/gridheap/squali

## Instructions to run your project

Clone the repository. Install Node.js 24.21.0, pnpm 11.25.0, Git, PostgreSQL 17+ and Python 3. Then run:

```sh
pnpm install --frozen-lockfile
bash scripts/setup-local.sh
pnpm dev
```

Open http://127.0.0.1:8787 and connect with the local reviewer fixture `local-admin-test-token`. Create a workspace, propose changes, approve exact versions, preview a selection and publish. Agents use `local-agent-test-token`. These fixture credentials are local only.

Run `pnpm typecheck`, `pnpm test:e2e` and `pnpm build` for validation. The full E2E suite needs an existing Brave browser on macOS or Chromium on Linux; set `SQUALI_BROWSER` to its executable. Tests never download a browser. `pnpm test:api` runs the browser-free API subset. README and `docs/source-operations.md` describe the sparse clients, native import and production configuration. `docs/scion-acceptance.md` links the retained acceptance evidence.

## Video and team fields

Upload [squali-source-demo.mp4 from release v0.2.0](https://github.com/gridheap/squali/releases/download/v0.2.0/squali-source-demo.mp4): 6 minutes 50 seconds, 25,416,963 bytes, H.264/AAC. The form accepts MP4, WebM or MOV up to 2 GiB; the demonstration must be 5–10 minutes. The old v0.1.0 video predates this architecture.

The entrant supplies the team name, primary contact, location and attendee details, then personally reviews the required confirmations. Do not fill personal fields with invented details.
