# Clerk sign-in and GitHub import

## Status

The code passes local HTTP, browser and real Git acceptance tests. **Production GitHub sign-in is not activated yet:** the Squali production Clerk instance still needs GitHub OAuth client credentials, and the Worker needs `CLERK_SECRET_KEY`. No user's GitHub repositories have been imported into production by this work. The existing public application retains token access until Clerk is configured.

## User workflow

1. Continue with GitHub through Clerk's hosted account portal.
2. Open **GitHub repositories**. Squali lists repositories GitHub authorizes, including private, collaborator and organization repositories. Organization restrictions and SSO authorization still apply.
3. Select repositories, or use **Import all repositories**. The latter walks all catalog pages before enqueueing a deduplicated batch.
4. The deployment admits one active import at a time to preserve capacity in the five-connection origin pool. The browser processes one durable import at a time. Pause stops after the current repository. Closing the browser stops further dispatch; reopen and choose **Resume pending**. There is no unattended queue consumer or schedule.
5. Completed repositories become private workspaces. Create proposals, review, and publish against the original default branch. An empty repository can receive its first commit through the same review workflow.
6. Open **Agent access** to issue a role-specific credential for one workspace. Keep it in a secret manager as `SQUALI_TOKEN`. Tokens expire in 1–30 days, can be revoked, and are revealed once. Only SHA-256 digests are stored. Existing deployment wildcard credentials have access to legacy workspaces only; they do not gain access to personal imports.

## What is copied

All advertised heads and tags and their reachable Git history, including executable modes, symlinks and binary Git objects, are streamed into Artifacts. The source GitHub repository is never modified. This is a one-time independent copy, not continuous bidirectional synchronization. LFS file payloads and submodule repositories are **not** transferred; their pointers and links remain in Git. Issues, pull requests, releases, actions and GitHub settings are outside this Git import.

Private source credentials are fetched from Clerk on the server, used only in request headers, and never placed in clone URLs, durable jobs or browser responses. Source URLs are constructed from a fixed GitHub origin and a validated repository identity; clients cannot supply arbitrary import URLs.

## Recovery and limits

- Stable identity: Clerk owner + numeric GitHub repository ID; renames do not create a second job.
- Fresh catalogs are cached for 15 minutes. Authorization is rechecked before a new transfer.
- Immutable source refs are saved before transfer. Retries inspect destination refs first. A completed copy never downloads again.
- PostgreSQL advisory locks prevent parallel dispatch of the same job and release on process death. Expected-empty ref writes protect against late duplicate writers. Atomic receive is requested only when the destination advertises support; otherwise the workspace remains unavailable until every ref is present.
- A real SIGKILL test proves recovery after Git accepted the import. It does not prove every network/provider failure condition.
- Limit: 100 pages / 10,000 discovered repositories; 1,000 queued records per account; 5,000 refs and 256 MiB per transfer; three explicitly dispatched import attempts. Jobs remain visible when limits stop them. Stream size is bounded even when metadata underestimates it.
- At most 32 active automation credentials per workspace.
- GitHub catalog/import provider dispatch is capped at 500 requests per account per database day; there are no automatic retries.
- Existing deployment caps remain 10 workspaces and 2,000 conservative Artifacts reservations/month. **Import all does not bypass these caps.** Large accounts can therefore have pending jobs rather than all repositories completing.
- Artifacts source storage is metered separately from call reservations. A transfer ceiling bounds work but is not a storage invoice. An acknowledgement recovered after a crash may report unknown transferred bytes (`null`).

## Production configuration

Clerk application: `app_3KexbCz21GVysghwY84Y7MOniwV` (Squali).
Production instance: `ins_3KexhIQI8xE85ENLgecfyc89Nwu`.
Frontend API: `https://clerk.squa.li`; hosted account portal: `https://accounts.squa.li`.
GitHub OAuth callback: `https://clerk.squa.li/v1/oauth_callback`.

1. Register the prepared **Squali** OAuth app in the `gridheap` organization. Use exact callback matching. Add its Client ID and Client Secret to Clerk's production GitHub connection.
2. For private repositories, configure GitHub's `repo` OAuth scope in Clerk. GitHub defines this scope as repository read/write access; Squali's integration implements reads from GitHub only. Each user must consent in GitHub, and organizations may need to approve access.
3. Save `CLERK_SECRET_KEY` outside the repository in a mode-0600 file. Set `CLERK_PUBLISHABLE_KEY` to this production instance's public key. `CLERK_JWT_KEY` is optional; absent that, Clerk's SDK uses its cached verification keys. The backend checks issuer, signature, expiry, session identity and `azp=https://squa.li`.
4. Supply keys using Wrangler secrets/configuration and deploy. Never paste secret values into command arguments or source files. The domain's static CSP already allows the specific `clerk.squa.li` origin; forks must replace this with their own Clerk domain.
5. Run one bounded live sign-in/import smoke, then reconcile reservations. Use a single small owned test repository, not **Import all**, for deployment verification. The real provider smoke has not yet run.

## Repeatable acceptance

```sh
pnpm typecheck
pnpm test:github
pnpm test:e2e
pnpm test:crash
# With the local server running:
SQUALI_URL=http://127.0.0.1:8793 pnpm test:ui
pnpm build
```

`test:github` uses the official Clerk backend signature verifier with signed fixture sessions, a local Clerk/GitHub HTTP boundary, real PostgreSQL and Git, and installed Brave in an isolated profile. The frontend SDK boundary is simulated for deterministic sign-in tests; this is **not evidence of a completed live OAuth consent flow**. The suite verifies owner isolation, expiring/forged/foreign sessions, private history/branches/annotated tags, source permissions lost and restored, failed allocation, empty repositories, deduplication, browser Import all/resume/sign-out, scoped agent credentials, bounded concurrent import admission, and SIGKILL recovery.

Sources: [Clerk OAuth access tokens](https://clerk.com/docs/reference/backend/user/get-user-oauth-access-token), [GitHub repository API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user), [Artifacts Git compatibility](https://developers.cloudflare.com/artifacts/).
