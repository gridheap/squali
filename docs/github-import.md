# Clerk sign-in and GitHub import

## Status

Clerk production keys, domains and GitHub OAuth are configured. The current production browser flow passes: GitHub login returns to Squali, lists 97 authorized repositories and shows the retained private import running. A cropped screenshot excludes unrelated private repository names. The large private fixture is being imported through the native source pipeline with its retained cache and journal.

## User workflow

1. Continue with GitHub through Clerk's hosted account portal. Identity sign-in requests `read:user` and `user:email`.
2. Open **GitHub repositories**, then explicitly **Grant repository access**. Import requires GitHub's `repo` scope. GitHub describes it as read/write access; Squali only reads the source repository. Organization restrictions and SSO authorization still apply.
3. Select repositories or choose **Import all repositories**. The latter walks catalog pages and enqueues deduplicated identities under the deployment caps.
4. With native imports enabled, one existing native runner consumes the durable PostgreSQL queue. Closing the browser does not cancel the job. Pause requests stop the active child and preserve the cache/journal; resume is explicit. Visible progress refreshes every 15 seconds, with at most 240 automatic polls per document or explicit refresh window. **Refresh progress** reads the current status and starts a new bounded window; it never starts, resumes or retries a transfer. The page explains when automatic updates pause.
5. Completed repositories appear in the workspace selector without a page reload and become private workspaces against the original default branch. Propose, review and publish changes. An empty repository can receive its first commit through the same workflow.
6. **Agent access** issues a role-specific credential for one workspace. Tokens expire in 1–30 days, are revocable and are revealed once. Only digests are stored. Optional directory prefixes narrow access. Legacy wildcard credentials do not gain access to personal workspaces.

## What is copied

Advertised branches, tags and their reachable Git history, executable modes, symlinks and binary Git objects are ingested into the canonical source store. PostgreSQL stores changesets and derivable metadata; R2 stores independent content-addressed blobs. A bounded native Git seed creates a derived Artifacts copy for clone/fetch. Import preserves nested and blob tags and historical commit encodings.

This is an independent copy; no continuous bidirectional synchronization is implemented. GitHub source refs are never modified. LFS payloads and submodule repositories are not transferred; their pointers remain. Issues, pull requests, releases, Actions and GitHub settings are outside the Git import.

Clerk supplies private repository credentials on the backend. Only a short-lived internal job token matching the current database lease can fetch them. Browser responses, clone URLs and persistent Git configuration never contain those credentials. GitHub URLs are constructed from a fixed provider origin and verified repository identity.

## Recovery and limits

- Identity is Clerk owner plus numeric GitHub repository ID. Renames do not allocate a second job. Catalog pages are cached for 15 minutes; new transfers recheck authorization.
- One native runner holds a fleet advisory lock and admits one active job. Its cache marker, frozen refs, object inventory and journal survive restart. A confirmed completed input is not uploaded again.
- Each native job has a cumulative eight-hour budget and at most three explicit attempts. Healthy process checkpoints continue the same attempt. Failed jobs never automatically retry.
- Default source limits are 500,000 objects, 16 GiB raw bytes, 12,000 HTTP attempts and 5,000 refs. Reported GitHub repository size is capped at 2 GiB for native admission. The actual object inventory is checked before source upload.
- Individual source blobs are limited to 32 MiB. Metadata sealing uses bounded batches; validated oversize errors reduce batch size. Other errors stop. Ambiguous R2 acknowledgements are reconciled by immutable key, with a maximum of three writes to a missing blob.
- Catalog: at most 100 pages / 10,000 repositories. Per owner: at most 1,000 queue records and 500 provider dispatch reservations per database day. Tokens: at most 32 active automation credentials per workspace.
- Current deployment caps: 100 workspaces, 2,000 Artifacts reservations/month, and 200,000 source R2 read/write reservations each. Import all respects these caps; pending jobs remain visible when admission stops them.
- Artifacts limits a compatibility repository to 1 GB. Larger source data can complete independently with a specific compatibility-limit status. Storage charges are separate from request reservations.

The retained legacy Worker streaming importer has a 512 MiB transfer ceiling and three explicit attempts. Its old failed attempts are not reset when a cache is adopted into the source pipeline. Legacy `/reconcile` checks destination refs without downloading again. The native runner uses its own durable lease and cumulative budgets.

## Production configuration

Clerk application: `app_3KexbCz21GVysghwY84Y7MOniwV` (Squali). Production instance: `ins_3KexhIQI8xE85ENLgecfyc89Nwu`.

Frontend API: `https://clerk.squa.li`; account portal: `https://accounts.squa.li`; GitHub callback: `https://clerk.squa.li/v1/oauth_callback`.

1. Register an OAuth application for your deployment. Squali's Grid Heap app is `3930566`, public Client ID `Ov23liNk8xGWYFISCUjn`. Callback matching is exact.
2. Default login uses `read:user` and `user:email`. The import screen requests external-account reauthorization for the additional `repo` grant. Users consent through GitHub; organizations may separately approve access.
3. Inject `CLERK_SECRET_KEY` as a Worker secret and configure `CLERK_PUBLISHABLE_KEY`. Optional `CLERK_JWT_KEY` avoids a verification-key fetch; otherwise Clerk's SDK caches verification keys. The backend verifies issuer, signature, expiry, session identity and `azp=https://squa.li`.
4. Apply the additive schema, source R2 binding and native runner configuration before setting `NATIVE_IMPORTS=true`. The [source operations guide](source-operations.md) describes the bounded service. Forks must replace Clerk origins in CSP as well as their own Cloudflare identities.
5. Complete one bounded live login/import verification, then reconcile application and provider counters. Reuse retained successful fixtures. Keep API secrets in protected files/environment, never command arguments or source control.

## Repeatable acceptance

```sh
pnpm typecheck
node --import tsx --test tests/github.test.ts tests/native-jobs.test.ts tests/source.test.ts tests/source-git.test.ts
# With the local server running:
pnpm test:ui
pnpm build
```

Tests use the official Clerk signature verifier with signed fixture sessions, local Clerk/GitHub boundaries, real PostgreSQL/Git and installed Brave in an isolated profile. They cover private history/tags, owner isolation, unauthorized scopes, allocation failures, pause/resume, cache reuse, healthy checkpoints, expired leases and process restart. Local boundaries are explicitly labelled; a live OAuth grant is a separate gate.

Sources: [Clerk OAuth access tokens](https://clerk.com/docs/reference/backend/user/get-user-oauth-access-token), [GitHub repository API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user), [Artifacts](https://developers.cloudflare.com/artifacts/).
