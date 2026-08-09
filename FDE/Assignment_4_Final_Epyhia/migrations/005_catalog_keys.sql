ALTER TABLE rental_items
  ADD COLUMN IF NOT EXISTS item_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_items_key
  ON rental_items(tenant_id, item_key)
  WHERE item_key IS NOT NULL;
