-- Contacts table: centralized contact registry
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'person',  -- person | machine | service
  email       TEXT,
  phone       TEXT,
  telegram_id TEXT,
  ssh_host    TEXT,
  ssh_user    TEXT,
  ip          TEXT,
  hostname    TEXT,
  role        TEXT,           -- owner, peer, family, client, service, monitored, self
  url         TEXT,
  metadata    JSON NOT NULL DEFAULT '{}',
  tags        JSON NOT NULL DEFAULT '[]',
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_telegram ON contacts(telegram_id);
CREATE INDEX IF NOT EXISTS idx_contacts_role ON contacts(role);

-- Audit trail for contact changes
CREATE TABLE IF NOT EXISTS contact_actions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,  -- created | updated | deleted
  changes     JSON,
  agent       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_actions_contact ON contact_actions(contact_id);
