CREATE TABLE IF NOT EXISTS weave_projects (
 id text PRIMARY KEY, name text NOT NULL, artifact text NOT NULL UNIQUE,
 remote text, head text, state text NOT NULL DEFAULT 'creating', request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS weave_changes (
 project text NOT NULL REFERENCES weave_projects(id), id text NOT NULL,
 request_hash text NOT NULL, author text NOT NULL, title text NOT NULL, intent text NOT NULL,
 context jsonb NOT NULL, dependencies text[] NOT NULL DEFAULT '{}', base text NOT NULL,
 oid text, files jsonb NOT NULL, status text NOT NULL DEFAULT 'preparing',
 reviewer text, review_note text, reviewed_at timestamptz, publication text,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project,id)
);
CREATE INDEX IF NOT EXISTS weave_changes_active ON weave_changes(project,status,created_at DESC);
CREATE TABLE IF NOT EXISTS weave_paths (
 project text NOT NULL, change_id text NOT NULL, path text NOT NULL,
 PRIMARY KEY(project,change_id,path), FOREIGN KEY(project,change_id) REFERENCES weave_changes(project,id)
);
CREATE INDEX IF NOT EXISTS weave_paths_lookup ON weave_paths(project,path);
CREATE TABLE IF NOT EXISTS weave_publications (
 project text NOT NULL REFERENCES weave_projects(id), id text NOT NULL,
 request_hash text NOT NULL, base text NOT NULL, oid text, changes text[] NOT NULL,
 actor text NOT NULL, state text NOT NULL DEFAULT 'preparing', metrics jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project,id)
);
CREATE TABLE IF NOT EXISTS weave_events (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project text NOT NULL REFERENCES weave_projects(id),
 kind text NOT NULL, actor text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weave_events_project ON weave_events(project,seq DESC);
CREATE TABLE IF NOT EXISTS weave_usage (
 month text PRIMARY KEY, attempts bigint NOT NULL DEFAULT 0
);

ALTER TABLE weave_projects ADD COLUMN IF NOT EXISTS owner_id text;
CREATE INDEX IF NOT EXISTS weave_projects_owner ON weave_projects(owner_id,created_at DESC);
ALTER TABLE weave_projects ADD COLUMN IF NOT EXISTS main_ref text NOT NULL DEFAULT 'refs/heads/main';
CREATE TABLE IF NOT EXISTS weave_github_catalog (
 owner_id text NOT NULL,page integer NOT NULL,payload jsonb NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,page)
);
CREATE TABLE IF NOT EXISTS weave_github_imports (
 id text PRIMARY KEY,owner_id text NOT NULL,repository_id bigint NOT NULL,
 project_id text NOT NULL,metadata jsonb NOT NULL,state text NOT NULL DEFAULT 'queued',
 refs jsonb,head text,attempts integer NOT NULL DEFAULT 0,bytes bigint NOT NULL DEFAULT 0,
 error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,repository_id)
);
CREATE INDEX IF NOT EXISTS weave_github_imports_owner ON weave_github_imports(owner_id,created_at);
CREATE TABLE IF NOT EXISTS weave_provider_usage (
 owner_id text NOT NULL,day date NOT NULL,attempts integer NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,day)
);
CREATE TABLE IF NOT EXISTS weave_tokens (
 id text PRIMARY KEY,project text NOT NULL REFERENCES weave_projects(id),
 token_hash text NOT NULL UNIQUE,label text NOT NULL,role text NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS weave_tokens_project ON weave_tokens(project,created_at DESC);
CREATE TABLE IF NOT EXISTS weave_cache_usage (
 month text NOT NULL, kind text NOT NULL, reservations bigint NOT NULL,
 PRIMARY KEY(month,kind)
);
CREATE TABLE IF NOT EXISTS weave_cache_entries (
 key text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS weave_derived (
 project text NOT NULL REFERENCES weave_projects(id), kind text NOT NULL, key text NOT NULL,
 value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project,kind,key)
);
ALTER TABLE weave_tokens ADD COLUMN IF NOT EXISTS paths text[];
CREATE TABLE IF NOT EXISTS weave_review_policy (
 project text PRIMARY KEY REFERENCES weave_projects(id), rules jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS weave_commit_graph (
 project text NOT NULL REFERENCES weave_projects(id), version integer NOT NULL,
 oid text NOT NULL, tree text NOT NULL, parents text[] NOT NULL, message text NOT NULL,
 generation bigint, first_depth bigint NOT NULL DEFAULT 0, linear_span bigint NOT NULL DEFAULT 0,
 jumps text[] NOT NULL DEFAULT '{}', PRIMARY KEY(project,version,oid)
);
CREATE TABLE IF NOT EXISTS weave_graph_builds (
 project text NOT NULL REFERENCES weave_projects(id), version integer NOT NULL,
 root text NOT NULL, stack text[] NOT NULL, lease text, lease_until timestamptz,
 PRIMARY KEY(project,version,root)
);
ALTER TABLE weave_commit_graph ADD COLUMN IF NOT EXISTS tree_span bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS weave_graph_parents ON weave_commit_graph USING gin(parents);
