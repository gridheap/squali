# HTTP contract

Every API request needs `Authorization: Bearer <token>`. Mutation bodies are JSON. Tokens map to a principal ID, a role and an explicit project allowlist. `*` covers legacy workspaces only; owner workspaces require owner sessions or explicit workspace credentials.

| Route | Method | Role | Input / behavior |
| --- | --- | --- | --- |
| `/api/session` | GET | any | Principal and deployment mode |
| `/api/usage` | GET | any | Attempt reservations and monthly cap |
| `/api/projects` | GET | any | Up to 100 accessible workspaces |
| `/api/projects` | POST | admin | `id`, `name`, initial `files` |
| `/api/projects/:project` | GET | scoped | Current Git head and workspace metadata |
| `/api/projects/:project/tree` | GET | scoped | Optional immutable `ref` and directory `path` |
| `/api/projects/:project/file` | GET | scoped | `path`, optional immutable `ref` |
| `/api/projects/:project/changes` | GET | scoped | Most recent 200 changes and up to 200 overlapping path pairs |
| `/api/projects/:project/changes` | POST | agent/admin | `id`, `title`, `intent`, `context`, `dependencies`, optional `base`, `files` |
| `/api/projects/:project/changes/:id` | GET | scoped | Context and complete changed-file before/after text |
| `/api/projects/:project/changes/:id/review` | POST | reviewer/admin | `decision`: `approved`, `rejected`, or `proposed`; optional `note` |
| `/api/projects/:project/changes/:id/revise` | POST | author/admin | New `id`, resolved `files`, `note`. Fresh approval required. |
| `/api/projects/:project/preview` | POST | scoped | `changes`: 1–64 IDs. Returns head, conflicts, unapproved changes and changed-file sizes. |
| `/api/projects/:project/publish` | POST | reviewer/admin | `id`, `changes`, optional `expectedHead`; use preview's head for stale-preview protection. |
| `/api/projects/:project/publications` | GET | scoped | Most recent 100 durable publication records |
| `/api/projects/:project/publications/:id/abort` | POST | reviewer/admin | `expectedHead`, `note`; appends an unchanged-tree audit commit using Git CAS; returns `cancellationHead`; a delayed publication loses to a successful cancellation |
| `/api/projects/:project/events` | GET | scoped | `after`: monotonically increasing event cursor; at most 200 events |

`files` is an array of `{path, content, mode?}`. `content: null` deletes a file. Modes are `100644` and `100755`. Paths are repository-relative. File/directory replacements, traversal and `.git` paths are rejected. Use a new immutable change ID to replace an earlier proposal.

Workspace, change and publication IDs are idempotency keys. Replay exactly the same JSON fields after a network interruption. A changed payload with an existing ID returns `409`. Do not generate a new ID merely because a response timed out.

Limits: 2 MiB request body, 64 files/change, 256 KiB/file, 1 MiB/change, 32 KiB context, 32 dependencies, 64 changes/publication, 256 file revisions/publication and 2 MiB published text. Text reconciliation limits each input to 2,000 lines and a batch to 12,000 input lines. Exceeding text merge limits produces a reviewable conflict; request/data limits return `413`.

Roles: readers inspect and preview; agents propose and revise their own work; reviewers approve and publish; admins create projects and can perform other operations. Enforce distinct reviewer credentials operationally; the prototype does not require two distinct human identities for every approval.

Error responses are `{error, message, details?}`. `401` means missing credentials; `403` means role or scope denied; `409` means a revision, refreshed preview or recovery is needed; `429` means an allocation or call budget is exhausted. No hidden retry loop follows these responses.

## Authenticated Git reads

Use `/api/projects/:project/git` as a Git remote and supply the same bearer token through a credential helper or a protected Git configuration. The gateway permits only `info/refs?service=git-upload-pack` and `git-upload-pack`; receive-pack and other operations return `403`. Requests remain project-scoped and upstream calls share the operation cap. The Artifacts remote returned in project metadata requires a separate Artifacts credential; a Squali bearer token is not an Artifacts token.

## Clerk and GitHub

`GET /api/auth/config` is public and returns the configured Clerk publishable key, or `null` while disabled. Other endpoints require a bearer credential. Clerk session JWTs are checked against the configured issuer and authorized origin. Personal workspaces are owner-isolated; scoped machine credentials can access only their workspace. Legacy wildcard credentials cover legacy workspaces only.

| Method | Path | Input / behavior |
|---|---|---|
| GET | `/api/github/repositories?page=1` | Owner session; 100 items/page, `repositories`, `nextPage`, `truncated`; cache 15 minutes |
| POST | `/api/github/imports` | `{repositoryIds:[123,456]}` from a fresh authorized catalog; deduplicated by owner + repository ID |
| GET | `/api/github/imports` | Durable progress; no secrets returned |
| POST | `/api/github/imports/:id/run` | `{}`; run or reconcile one job; repeat completed jobs without provider calls; 409 when another import is active |
| POST | `/api/projects/:id/tokens` | Owner only; `{label,role:'agent'|'reader'|'reviewer',days:1..30}`; raw token revealed once |
| GET | `/api/projects/:id/tokens` | Owner only; metadata and expiry/revocation, never plaintext tokens or hashes |
| POST | `/api/projects/:id/tokens/:tokenId/revoke` | Owner only; `{}`; immediately prevents new authenticated requests |

Import returns `queued`, `running`, `failed` or `complete`. A job retains its immutable source refs. A failed job can be resumed within its three-attempt ceiling; limits do not trigger automatic retries. `bytes: null` means transfer size was not recorded before interruption. See [the import guide](github-import.md) for scope, storage limits and production activation status.

## Source service and policy

All immutable refs are full 40-character commit IDs. Authorization runs before cache access. Directory credentials cannot use whole-repository Git or raw object batches.

| Method | Project suffix | Input / result |
|---|---|---|
| POST | `/objects` | `{objects:[{type:"commit"|"tree"|"blob",oid}]}`; 1–32 objects; 1 MiB JSON result; blobs above 512 KiB use `/blob` |
| GET | `/blob?ref=&path=` | Exact regular-file bytes up to 32 MiB; private/no-store; Git object identity header |
| GET | `/commit?ref=` | Immutable commit metadata |
| POST | `/ancestry` | `{ancestor,descendant}` → `isAncestor` |
| POST | `/merge-base` | `{left,right}` → all lowest common `bases` |
| POST | `/diff` | `{from,to,path?}` → changed files; at most 64 files / 1 MiB text / 256 trees |
| GET | `/path-history?ref=&path=&limit=` | First-parent history, 1–50 entries; at most 64 scanned commits/page; `next` ref |
| GET | `/blame?ref=&path=` | Original commit and line per line; 2,000 lines, 4 million comparison budget |
| POST | `/bisect` | `{good,bad}` → first-parent candidate or culprit; no test execution |
| POST | `/revert` | `{id,commit,note?}` → an inverse proposal requiring review; conflicting later edits stop |
| GET | `/search?ref=&query=&path=&cursor=` | Path-name search; 50 matches, 2,000 entries / 64 trees per page; query-bound cursor |
| GET/POST | `/policy` | Owner/admin; `{rules:[{prefix,independentReview,requireEvidence}]}`; up to 32 rules |

Graph computations are bounded to 256 unique commits per request. Versioned derived records are reused. These limits return explicit errors, not partial ancestry answers. For directory tokens, history omits unrestricted commit messages/trees and diff/search require an authorized path. Proposal operations validate their dependency closure before source reads (up to 64 records). The recent scoped list includes only changes whose dependency closure is also visible within that window.

Token creation accepts optional `paths:["docs","src/api"]`; omit or use `null` for a whole workspace. Policies require distinct principals where configured; evidence is supplied by the agent, not attested CI. Updating policy invalidates earlier affected approvals and is blocked while a publication is unresolved.

`POST /api/github/imports/:id/reconcile` checks destination refs and finalizes a complete import without downloading or allocating another repository. An incomplete result returns 409 without changing its failure evidence or transfer count. `/run` has a three-transfer-attempt ceiling.

`GET /api/usage` also returns `cache.reservedReads`, `reservedWrites`, `readCap` and `writeCap`. These are application reservations, not provider billing measurements.
