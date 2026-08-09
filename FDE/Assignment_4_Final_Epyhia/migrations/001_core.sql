CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  business_name TEXT NOT NULL,
  business_slug TEXT NOT NULL UNIQUE,
  business_email TEXT NOT NULL,
  business_phone TEXT NOT NULL,
  business_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand_documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  full_text TEXT NOT NULL CHECK (length(full_text) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version_number)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  original_brief TEXT NOT NULL,
  completed_brief TEXT,
  brief_hash TEXT NOT NULL,
  brand_document_id TEXT REFERENCES brand_documents(id),
  approved_budget_microdollars BIGINT NOT NULL
    CHECK (approved_budget_microdollars >= 0),
  budget_approved_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS completed_brief TEXT;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  output_ref TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, task_type)
);

CREATE TABLE IF NOT EXISTS onboarding_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agent_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT REFERENCES tasks(id),
  agent_name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reserved_cost_microdollars BIGINT NOT NULL DEFAULT 0
    CHECK (reserved_cost_microdollars >= 0),
  cost_microdollars BIGINT NOT NULL DEFAULT 0 CHECK (cost_microdollars >= 0),
  status TEXT NOT NULL,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
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
  approval_status TEXT NOT NULL,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  provider_reference TEXT,
  provider_cost_microdollars BIGINT NOT NULL DEFAULT 0
    CHECK (provider_cost_microdollars >= 0),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, action_type, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_calls_run_id ON agent_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_run_id ON actions(run_id);
