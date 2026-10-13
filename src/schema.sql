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
