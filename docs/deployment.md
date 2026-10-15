# Deploying Squali

## Prerequisites

Cloudflare Workers Paid with Artifacts access, a dedicated PostgreSQL database and role, a Hyperdrive configuration with SQL caching disabled, and a licensed Adobe Web Project (or an explicit empty kit for native fallback).

The checked-in account ID targets the owner's Grid Heap account. Forks must set their own account ID. `wrangler.jsonc` binds the `weave` Artifacts namespace; the namespace is created implicitly when its first repository is created through the binding. REST API permissions and Workers binding authentication are separate. Regenerate types with `pnpm exec wrangler types` after editing bindings.

1. Create a dedicated PostgreSQL database and role. Grant that role only its own `weave` schema. Use TLS and a connection limit. Set the role's database-specific default `search_path` to `weave`; Hyperdrive does not preserve the driver startup setting. Run `DATABASE_URL=... pnpm db:migrate` using credentials injected securely in the process environment.
2. Create a Hyperdrive configuration with caching disabled and an origin connection limit of eight (with database capacity and role headroom verified). Add `hyperdrive: [{binding: "HYPERDRIVE", id: "..."}]` to Wrangler. Prefer private connectivity; do not broadly open a database firewall.
3. Supply `PRINCIPALS_JSON` as a Worker secret. It maps SHA-256 token digests to principals:

```json
{
  "<sha256 of random reviewer token>": {"id":"reviewer","role":"reviewer","projects":["demo"]},
  "<sha256 of random agent token>": {"id":"agent-docs","role":"agent","projects":["demo"]},
  "<sha256 of random administrator token>": {"id":"owner","role":"admin","projects":["*"]}
}
```

Generate tokens with a cryptographic RNG. Never commit raw tokens, paste them into tickets, pass them as CLI arguments, or store them in the browser. A local secret file should have mode 0600 and be outside the source repository. `wrangler secret bulk <private-file>` can consume it.

4. Set the monthly Artifacts call cap and project cap. The initial configuration allows 2,000 attempted calls/month and 100 projects. A bounded cloud smoke test should use one workspace, two independent changes and one publication; exercise conflicts/revisions with the local E2E fixtures, with a total ceiling of 250 reservations. Do not run the local benchmark against the live provider.
5. Configure the Adobe kit in `public/index.html` and `ADOBE_KIT_ID`. Use its official CSS embed; no font files are bundled. The application gates dependent text for at most 2.8 seconds per CSS/font stage while native editors and feedback remain usable.
6. Run `pnpm typecheck`, `pnpm test:e2e`, `pnpm build`, then `pnpm deploy`. Validate the Worker entry point, authentication, real Artifacts reads/writes, and the PostgreSQL journal. Record both the provider usage view and the application's conservative call counter.

Static assets include a CSP and referrer policy in `_headers`. The API has the same-origin mutation check and bearer authorization. Production does not include local fixture credentials.

## Clerk and GitHub

See [the sign-in and import deployment guide](github-import.md). Production OAuth is configured; the current live browser login/catalog flow passes, while the large private import remains an acceptance gate. Apply the additive schema migration before deploying this version. Wildcard principals now cover legacy workspaces; personal workspaces require owner sessions or explicit workspace credentials.

## Recovery

- Retry create/propose/publish with the same ID and exact input after a timeout.
- A preparing publication whose commit already equals main is finalized by replaying the original publish request.
- Cancellation appends an unchanged-tree audit commit by expected-old-head CAS. A successful cancellation rejects delayed publication pushes from the previous base. If publication wins first, retry its original request to finalize it. Retry an interrupted cancellation with its original expected head and note.
- If main moved after an ambiguous outcome, freeze that workspace's publishing and inspect the Git graph and journal. Do not force-push or blindly delete journal records. The prototype deliberately requires administrator reconciliation here.
- A Worker terminated before Git acceptance can be recovered by replaying the original publication. The saved author and timestamp produce the same commit even if another authorized reviewer retries. Old active markers do not block recovery. No administrator SQL mutation or timeout lease is required.
- The call cap resets by UTC month. Do not raise it automatically. Reads hitting the immutable cache still work when no upstream call is needed.

## Teardown

There are no model-provider integrations or application Durable Objects. The native PostgreSQL queue consumer runs as `squali-native` on an existing VM. Stop that service and archive its retained caches/journals before removing its database access. Remove the Worker, the dedicated Hyperdrive configuration, the dedicated Artifacts repositories/namespace, and the dedicated PostgreSQL database/role only when their data is no longer needed. Revoke its access tokens. If a dedicated outbound connector was created, stop that connector and remove its tunnel/service too. Shared servers and unrelated applications must remain untouched.

## Production identity

The public product is Squali at https://squa.li, with source at https://github.com/gridheap/squali. The Worker, PostgreSQL schema, connector and Artifacts namespace retain their original internal `weave` identifiers so existing data and configuration remain intact. They are implementation identifiers, not separate products. `scripts/weave.mjs` and `WEAVE_URL`/`WEAVE_TOKEN` remain compatible aliases; new CLI usage is `scripts/squali.mjs` with `SQUALI_URL`/`SQUALI_TOKEN`.

The Wrangler configuration binds `squa.li` as a custom domain and disables `workers_dev` and preview URLs. Deployment should not restore the old public hostname. Forks must replace the domain, zone ID, account and Hyperdrive configuration with their own values.

## Execution placement

The production API uses `placement.region = "azure:eastus2"` to run near the dedicated PostgreSQL database. Static assets remain served near visitors. Cloudflare accepted this as targeted placement. A bounded before/after observation made three read-only `/api/usage` requests per configuration and no Artifacts calls: median total HTTP duration was 1.505 s before and 1.257 s after. This small sequential sample includes the local network and TLS setup; it is not a load benchmark or a guaranteed improvement. See [placement evidence](evidence/placement.json) and [Cloudflare placement documentation](https://developers.cloudflare.com/workers/configuration/placement/).

## R2 and execution limits

Bind a private `OBJECTS` bucket (production: `squali-objects`). Add a lifecycle rule for prefix `objects/`, expiring after seven days. Run the additive SQL migration before deploying the cache or policy version. Set `MONTHLY_R2_READ_CAP=20000` and `MONTHLY_R2_WRITE_CAP=2000`; reservations are conservative batches and include failures. The Worker CPU ceiling is 30,000 ms for bounded large transfers. This is a maximum per request, not a measured execution time. There is no Worker timer or Cloudflare Queue consumer. The native PostgreSQL consumer is described below; failed jobs never automatically retry.

## Authoritative source storage and native jobs

Bind a separate private `SOURCE` R2 bucket (production `squali-source`). Keep authoritative completed objects indefinitely; only abandoned multipart uploads may expire. Do not apply the disposable cache lifecycle to this bucket. Configure `MONTHLY_SOURCE_READ_CAP=200000`, `MONTHLY_SOURCE_WRITE_CAP=200000` and the logical repository byte admission limit shown in Wrangler. These source counters are independent of cache and Artifacts reservations.

Apply the additive schema before deployment. New production workspaces use the source adapter by default; old Artifacts workspaces keep their storage type. Native import needs the dedicated service in [source operations](source-operations.md), Python/Git and a protected PostgreSQL connection. Enable `NATIVE_IMPORTS=true` only after the runner is ready. Use one active job, 1 GiB memory, a finite service lifetime and three starts/hour. Current jobs retain their cumulative eight-hour and HTTP/object budgets across restarts.

Use existing VM/database capacity where possible. The production database role allows twelve connections; Hyperdrive admits eight origin connections and the native runner holds one notification/coordination connection. Network work does not pin a transaction. Install code while the runner is idle; changing the Worker or service must not restart a successful import from zero.

A large initial Git compatibility seed uses the native cache and a live internal lease. Worker-only exports admit 8,192 objects / 16 MiB expanded data. Exceeding Artifacts' repository size limit leaves source data available with an explicit compatibility-limit status. Keep both storage domains in backups; the source blobs and canonical PostgreSQL records are authoritative.

The Worker and local HTTP service share `src/database.ts`. Keep Postgres.js prepared statements enabled for Hyperdrive. This schema uses `text[]`, so native codecs must remain available: the bounded five-minute isolate cache reuses completed discovery while fresh/custom/oversized catalogs use normal discovery. Cloudflare warns that disabling preparation adds protocol exchanges and can hang intermittently under transaction pooling. The application uses one client connection per Worker request; the Hyperdrive pool and dedicated role caps remain separate.

## Submission latency settings

The authoritative source bucket has Local Uploads enabled. This setting lives in R2 bucket configuration, outside Wrangler bindings; inspect it with `pnpm exec wrangler r2 bucket local-uploads get squali-source`. Keep its data-retention policy unchanged. [Measurements and rollback considerations](tail-latency.md).

The regional Worker owns `/api/regional/*`, and its source binding must use the named `SourceRpc` entrypoint. The source default entrypoint forwards legacy RPCs through its REGIONAL binding. Follow the [ordered migration](regional-cache.md#current-deployment-order); removing the named entrypoint while the binding uses it breaks RPC reads. To roll back routing, first remove the source REGIONAL binding, restore the broad regional route/default source binding, and only then deploy a source version without SourceRpc. Local Uploads can be disabled independently without interrupting existing replication.
