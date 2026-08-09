ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS run_id TEXT REFERENCES runs(id);

CREATE INDEX IF NOT EXISTS idx_reservations_run ON reservations(run_id);
