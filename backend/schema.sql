PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO schema_version VALUES (1);
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, facts_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('original','derived')),
 parent_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
 path TEXT UNIQUE NOT NULL, name TEXT NOT NULL, media_type TEXT NOT NULL,
 width INTEGER NOT NULL CHECK(width>0), height INTEGER NOT NULL CHECK(height>0),
 byte_length INTEGER NOT NULL CHECK(byte_length>0), sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_references (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 role TEXT NOT NULL, position INTEGER NOT NULL,
 UNIQUE(product_id,asset_id), UNIQUE(product_id,position)
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
 idempotency_key TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
 input_json TEXT NOT NULL, policy_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','partial','failed','canceled')),
 revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 last_scheduled_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_assets (
 task_id TEXT NOT NULL REFERENCES tasks(id), asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 PRIMARY KEY(task_id,asset_id)
);
CREATE TABLE IF NOT EXISTS children (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), position INTEGER NOT NULL,
 slot_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','canceled')),
 generation INTEGER NOT NULL DEFAULT 1, attempt_count INTEGER NOT NULL DEFAULT 0,
 active_attempt TEXT, lease_until INTEGER, next_run_at INTEGER NOT NULL DEFAULT 0,
 stage TEXT NOT NULL DEFAULT 'queued', error_json TEXT,
 UNIQUE(task_id,position)
);
CREATE INDEX IF NOT EXISTS children_schedule ON children(state,next_run_at);
CREATE TABLE IF NOT EXISTS attempts (
 id TEXT PRIMARY KEY, child_id TEXT NOT NULL REFERENCES children(id),
 ordinal INTEGER NOT NULL, generation INTEGER NOT NULL, processor_id TEXT NOT NULL, replay_safe INTEGER NOT NULL,
 state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
 error_json TEXT, receipt_json TEXT, UNIQUE(child_id,ordinal)
);
CREATE TABLE IF NOT EXISTS results (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), child_id TEXT UNIQUE NOT NULL REFERENCES children(id),
 product_id TEXT NOT NULL REFERENCES products(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS result_versions (
 result_id TEXT NOT NULL REFERENCES results(id), version INTEGER NOT NULL,
 asset_id TEXT NOT NULL REFERENCES assets(id), attempt_id TEXT UNIQUE REFERENCES attempts(id),
 previous_version INTEGER, created_at INTEGER NOT NULL,
 PRIMARY KEY(result_id,version)
);
CREATE TABLE IF NOT EXISTS events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
 kind TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS result_edit_receipts (
 result_id TEXT NOT NULL REFERENCES results(id), edit_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, version INTEGER NOT NULL,
 PRIMARY KEY(result_id,edit_key),
 FOREIGN KEY(result_id,version) REFERENCES result_versions(result_id,version)
);

-- Explicit, bounded local recomposition; it must never permit a provider call.
CREATE TABLE IF NOT EXISTS local_replays (
 child_id TEXT NOT NULL REFERENCES children(id), generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(child_id,generation)
);
