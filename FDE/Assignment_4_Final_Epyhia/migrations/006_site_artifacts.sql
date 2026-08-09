CREATE TABLE IF NOT EXISTS site_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  brand_document_id TEXT NOT NULL REFERENCES brand_documents(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  html_content TEXT NOT NULL CHECK (length(html_content) > 0),
  content_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status = 'PASSED'),
  review_feedback JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision_number),
  UNIQUE (run_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_site_artifacts_run ON site_artifacts(run_id);
