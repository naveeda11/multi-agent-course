import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogService } from "../src/gate/catalog-service.js";
import { ValidationError } from "../src/shared/errors.js";

test("normalizes a grounded integer-cents catalog before Tier 3 persistence", async () => {
  const calls = [];
  const service = new CatalogService({
    repository: {
      async persistCatalog(input) {
        calls.push(input);
        return { items: input.items, replayed: false };
      },
    },
  });
  const result = await service.persist({
    tenantId: "tenant_demo",
    runId: "run_demo",
    idempotencyKey: "catalog-v1",
    items: [
      {
        itemKey: "folding-chair",
        name: " Folding Chair ",
        description: " White folding chair ",
        availableQuantity: 100,
        dayRateCents: 300,
        currency: "USD",
      },
    ],
  });
  assert.equal(calls[0].items[0].dayRateCents, 300);
  assert.equal(calls[0].items[0].currency, "usd");
  assert.equal(calls[0].items[0].name, "Folding Chair");
  assert.equal(result.replayed, false);
});

test("rejects duplicate catalog keys before touching persistence", async () => {
  let called = false;
  const service = new CatalogService({
    repository: {
      async persistCatalog() {
        called = true;
      },
    },
  });
  const item = {
    itemKey: "folding-chair",
    name: "Folding Chair",
    description: "White folding chair",
    availableQuantity: 100,
    dayRateCents: 300,
    currency: "usd",
  };
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      idempotencyKey: "catalog-v1",
      items: [item, item],
    }),
    ValidationError,
  );
  assert.equal(called, false);
});
