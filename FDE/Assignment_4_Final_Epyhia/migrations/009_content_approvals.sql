ALTER TABLE brand_documents
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE brand_documents
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE brand_documents
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

ALTER TABLE brand_documents
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE brand_documents
  DROP CONSTRAINT IF EXISTS brand_documents_approval_status_check;

ALTER TABLE brand_documents
  ADD CONSTRAINT brand_documents_approval_status_check
  CHECK (approval_status IN ('PENDING', 'APPROVED'));

ALTER TABLE brand_documents
  DROP CONSTRAINT IF EXISTS brand_documents_content_hash_check;

ALTER TABLE brand_documents
  ADD CONSTRAINT brand_documents_content_hash_check
  CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$');

CREATE INDEX IF NOT EXISTS idx_brand_documents_approval
  ON brand_documents(tenant_id, approval_status);
