ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_actions_execution_recovery
  ON actions (status, execution_started_at)
  WHERE status = 'EXECUTING';
