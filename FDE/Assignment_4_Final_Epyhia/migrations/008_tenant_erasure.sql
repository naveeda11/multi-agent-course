ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants(id);

UPDATE webhook_events AS event
SET tenant_id = action.tenant_id
FROM actions AS action
WHERE action.action_type = 'process-stripe-webhook'
  AND action.idempotency_key = event.stripe_event_id
  AND event.tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_events_tenant
  ON webhook_events(tenant_id);
