# Deploying Weave

## Prerequisites

Cloudflare Workers Paid with Artifacts access, a dedicated PostgreSQL database and role, a Hyperdrive configuration with SQL caching disabled, and a licensed Adobe Web Project (or an explicit empty kit for native fallback).

The checked-in account ID targets the owner's Grid Heap account. Forks must set their own account ID. `wrangler.jsonc` binds the `weave` Artifacts namespace; namespace creation and provider access must succeed before deploying. Regenerate types with `pnpm exec wrangler types` after editing bindings.

1. Create a dedicated PostgreSQL database and role. Grant that role only its own `weave` schema. Use TLS and a connection limit. Run `DATABASE_URL=... pnpm db:migrate` using credentials injected securely in the process environment.
2. Create a Hyperdrive configuration with caching disabled and an origin connection limit of five. Add `hyperdrive: [{binding: "HYPERDRIVE", id: "..."}]` to Wrangler. Prefer private connectivity; do not broadly open a database firewall.
3. Supply `PRINCIPALS_JSON` as a Worker secret. It maps SHA-256 token digests to principals:

```json
{
  "<sha256 of random reviewer token>": {"id":"reviewer","role":"reviewer","projects":["demo"]},
  "<sha256 of random agent token>": {"id":"agent-docs","role":"agent","projects":["demo"]},
  "<sha256 of random administrator token>": {"id":"owner","role":"admin","projects":["*"]}
}
```

Generate tokens with a cryptographic RNG. Never commit raw tokens, paste them into tickets, pass them as CLI arguments, or store them in the browser. A local secret file should have mode 0600 and be outside the source repository. `wrangler secret bulk <private-file>` can consume it.

4. Set the monthly Artifacts call cap and project cap. The initial configuration allows 2,000 attempted calls/month and 10 projects. A bounded cloud smoke test should use one workspace, two independent changes, one conflict/revision, and one publication, with a total ceiling of 250 reservations. Do not run the local benchmark against the live provider.
5. Configure the Adobe kit in `public/index.html` and `ADOBE_KIT_ID`. Use its official CSS embed; no font files are bundled. The application gates dependent text for at most 2.8 seconds per CSS/font stage while native editors and feedback remain usable.
6. Run `pnpm typecheck`, `pnpm test:e2e`, `pnpm build`, then `pnpm deploy`. Validate the Worker entry point, authentication, real Artifacts reads/writes, and the PostgreSQL journal. Record both the provider usage view and the application's conservative call counter.

Static assets include a CSP and referrer policy in `_headers`. The API has the same-origin mutation check and bearer authorization. Production does not include local fixture credentials.

## Recovery

- Retry create/propose/publish with the same ID and exact input after a timeout.
- A preparing publication whose commit already equals main is finalized by replaying the original publish request.
- A preparing publication that never reached Git can be cancelled with `POST /publications/:id/abort`, its expected unchanged base and an explanation.
- If main moved after an ambiguous outcome, freeze that workspace's publishing and inspect the Git graph and journal. Do not force-push or blindly delete journal records. The prototype deliberately requires administrator reconciliation here.
- The call cap resets by UTC month. Do not raise it automatically. Reads hitting the immutable cache still work when no upstream call is needed.

## Teardown

There are no schedules, queue consumers, model-provider integrations, or application Durable Objects. Remove the Worker, the dedicated Hyperdrive configuration, the dedicated Artifacts repositories/namespace, and the dedicated PostgreSQL database/role only when their data is no longer needed. Revoke its access tokens. If a dedicated outbound connector was created, stop that connector and remove its tunnel/service too. Shared servers and unrelated applications must remain untouched.
