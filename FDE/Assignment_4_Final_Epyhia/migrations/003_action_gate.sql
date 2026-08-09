CREATE TABLE IF NOT EXISTS deployment_projects (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  project_name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
