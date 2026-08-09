ALTER TABLE agent_calls
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS request_hash TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS output_text TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_calls_idempotency
  ON agent_calls (run_id, agent_name, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS payload_json JSONB,
  ADD COLUMN IF NOT EXISTS failure_message TEXT;

CREATE TABLE IF NOT EXISTS site_hosts (
  host TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rental_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL CHECK (length(name) > 0),
  description TEXT NOT NULL CHECK (length(description) > 0),
  available_quantity INTEGER NOT NULL CHECK (available_quantity > 0),
  day_rate_cents BIGINT NOT NULL CHECK (day_rate_cents > 0),
  currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency ~ '^[a-z]{3}$'),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL CHECK (length(name) > 0),
  email TEXT NOT NULL CHECK (length(email) > 0),
  normalized_email TEXT NOT NULL CHECK (normalized_email = lower(trim(normalized_email))),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, normalized_email)
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  idempotency_key TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date > start_date),
  rental_days INTEGER NOT NULL CHECK (rental_days > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED')),
  total_cents BIGINT NOT NULL CHECK (total_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  stripe_checkout_session_id TEXT,
  stripe_checkout_url TEXT,
  stripe_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (stripe_checkout_session_id)
);

CREATE TABLE IF NOT EXISTS reservation_items (
  id TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  rental_item_id TEXT NOT NULL REFERENCES rental_items(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  day_rate_cents BIGINT NOT NULL CHECK (day_rate_cents > 0),
  rental_days INTEGER NOT NULL CHECK (rental_days > 0),
  line_total_cents BIGINT NOT NULL CHECK (
    line_total_cents = quantity * day_rate_cents * rental_days
  ),
  UNIQUE (reservation_id, rental_item_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  status TEXT NOT NULL CHECK (status = 'PAID'),
  payment_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL CHECK (livemode = false),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  cloudflare_project_name TEXT NOT NULL UNIQUE,
  live_url TEXT NOT NULL,
  last_action_id TEXT NOT NULL REFERENCES actions(id),
  verified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  brand_document_id TEXT NOT NULL REFERENCES brand_documents(id),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'LANDING_COPY', 'SOCIAL_POST', 'LAUNCH_EMAIL', 'VIDEO_STORYBOARD',
    'VIDEO_LANDSCAPE', 'VIDEO_VERTICAL'
  )),
  sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
  channel TEXT,
  text_content TEXT,
  r2_object_key TEXT,
  mime_type TEXT,
  self_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (self_review_status IN ('PENDING', 'PASSED', 'FAILED')),
  grounding_check_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (grounding_check_status IN ('PENDING', 'PASSED', 'FAILED')),
  review_feedback TEXT,
  approval_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
    CHECK (approval_status IN ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, artifact_type, sequence_number),
  CHECK (
    (artifact_type IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')
      AND r2_object_key IS NOT NULL AND mime_type IS NOT NULL)
    OR
    (artifact_type NOT IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')
      AND text_content IS NOT NULL AND length(text_content) > 0)
  ),
  CHECK (
    approval_status <> 'APPROVED'
    OR (self_review_status = 'PASSED' AND grounding_check_status = 'PASSED')
  )
);

CREATE INDEX IF NOT EXISTS idx_site_hosts_tenant ON site_hosts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rental_items_tenant ON rental_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_reservations_availability
  ON reservations(tenant_id, start_date, end_date, status);
CREATE INDEX IF NOT EXISTS idx_reservation_items_item
  ON reservation_items(rental_item_id, reservation_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_marketing_artifacts_run ON marketing_artifacts(run_id);
