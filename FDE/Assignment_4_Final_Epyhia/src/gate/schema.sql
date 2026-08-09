PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  business_slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  original_brief TEXT NOT NULL,
  brief_hash TEXT NOT NULL,
  approved_budget_microdollars INTEGER NOT NULL CHECK (approved_budget_microdollars >= 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('TEST', 'LIVE')),
  approval_status TEXT NOT NULL CHECK (
    approval_status IN ('PENDING', 'APPROVED', 'NOT_REQUIRED')
  ),
  approved_by TEXT,
  approved_at TEXT,
  provider_reference TEXT,
  provider_cost_microdollars INTEGER NOT NULL DEFAULT 0
    CHECK (provider_cost_microdollars >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'EXECUTED', 'FAILED')
  ),
  failure_message TEXT,
  created_at TEXT NOT NULL,
  execution_started_at TEXT,
  executed_at TEXT,
  UNIQUE (tenant_id, action_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS action_payloads (
  action_id TEXT PRIMARY KEY REFERENCES actions(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_projects (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  project_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  cloudflare_project_name TEXT NOT NULL UNIQUE,
  live_url TEXT NOT NULL,
  last_action_id TEXT NOT NULL REFERENCES actions(id),
  verified_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actions_run_id ON actions(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
