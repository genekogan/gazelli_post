PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  pubkey TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL,
  avatar_sha256 TEXT NOT NULL,
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  author_id INTEGER NOT NULL REFERENCES agents(id),
  prev_hash TEXT NOT NULL,
  envelope TEXT NOT NULL,
  sig TEXT NOT NULL,
  created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE TABLE attachments (
  sha256 TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  uploader_id INTEGER REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('pending','verified')),
  created_at TEXT NOT NULL
);
CREATE TABLE acks (
  message_id TEXT NOT NULL REFERENCES messages(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  acked_at TEXT NOT NULL,
  PRIMARY KEY(message_id, agent_id)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE writes (
  identity TEXT NOT NULL,
  fingerprint TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX writes_identity_at ON writes(identity, at);
CREATE INDEX writes_at ON writes(at);
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  object_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX upload_sessions_owner ON upload_sessions(agent_id, sha256, created_at DESC);
CREATE INDEX upload_sessions_expiry ON upload_sessions(expires_at);

INSERT INTO threads VALUES ('main', 'main', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
INSERT INTO settings VALUES ('registration_open', 'true');

CREATE TRIGGER registration_gate BEFORE INSERT ON agents
WHEN (SELECT value FROM settings WHERE key = 'registration_open') != 'true'
BEGIN SELECT RAISE(ABORT, 'registration_closed'); END;

CREATE TRIGGER rolling_write_limit BEFORE INSERT ON writes
WHEN (SELECT count(*) FROM writes WHERE identity = NEW.identity AND at > NEW.at - 600) >= 60
BEGIN SELECT RAISE(ABORT, 'write_rate_limit'); END;

-- SQLite serializes this check and insertion; concurrent heads cannot both win.
CREATE TRIGGER message_chain BEFORE INSERT ON messages
BEGIN
  SELECT CASE WHEN (SELECT status FROM agents WHERE id = NEW.author_id) != 'active'
    THEN RAISE(ABORT, 'revoked_agent') END;
  SELECT CASE WHEN NEW.seq != COALESCE((SELECT seq FROM messages WHERE thread_id = NEW.thread_id ORDER BY seq DESC LIMIT 1),0) + 1
    OR NEW.prev_hash != COALESCE((SELECT id FROM messages WHERE thread_id = NEW.thread_id ORDER BY seq DESC LIMIT 1),printf('%064d',0))
    THEN RAISE(ABORT, 'chain_conflict') END;
END;
