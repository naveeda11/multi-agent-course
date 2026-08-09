import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureStripeWebhook } from "../scripts/configure-stripe-webhook.js";

const WEBHOOK_URL = "https://epyhia-test-web.fly.dev/stripe/webhook";
const NOW = 2_000_000_000;

function endpoint(overrides = {}) {
  return {
    id: "we_epyhia_test",
    url: WEBHOOK_URL,
    description: "EPYHIA sandbox order persistence",
    enabled_events: ["checkout.session.completed", "checkout.session.expired"],
    livemode: false,
    created: NOW - 60,
    status: "enabled",
    metadata: {
      epyhia_namespace: "epyhia-demo",
      epyhia_purpose: "order-persistence",
      epyhia_setup_version: "v2",
    },
    ...overrides,
  };
}

function stripeMock({ existing = [], created, updated } = {}) {
  const calls = { create: [], update: [] };
  return {
    calls,
    webhookEndpoints: {
      async list() {
        return { data: existing };
      },
      async create(input, options) {
        calls.create.push({ input, options });
        return created ?? endpoint({ secret: "whsec_created_test" });
      },
      async update(id, input) {
        calls.update.push({ id, input });
        return updated ?? endpoint();
      },
    },
  };
}

test("creates one namespaced test endpoint and captures its creation-only secret", async () => {
  const stripe = stripeMock();
  const result = await ensureStripeWebhook({
    stripe,
    webhookUrl: WEBHOOK_URL,
    nowSeconds: NOW,
  });

  assert.equal(result.endpointId, "we_epyhia_test");
  assert.equal(result.signingSecret, "whsec_created_test");
  assert.equal(result.created, true);
  assert.equal(result.recovered, false);
  assert.equal(stripe.calls.create.length, 1);
  assert.match(stripe.calls.create[0].options.idempotencyKey, /^epyhia-webhook-/);
  assert.deepEqual(stripe.calls.create[0].input.enabled_events, [
    "checkout.session.completed",
    "checkout.session.expired",
  ]);
  assert.equal(
    stripe.calls.create[0].input.metadata.epyhia_namespace,
    "epyhia-demo",
  );
});

test("replays the same recent endpoint to recover an interrupted secret staging", async () => {
  const stripe = stripeMock({
    existing: [endpoint()],
    created: endpoint({ secret: "whsec_recovered_test" }),
  });
  const result = await ensureStripeWebhook({
    stripe,
    webhookUrl: WEBHOOK_URL,
    nowSeconds: NOW,
  });

  assert.equal(result.endpointId, "we_epyhia_test");
  assert.equal(result.signingSecret, "whsec_recovered_test");
  assert.equal(result.created, false);
  assert.equal(result.recovered, true);
  assert.equal(stripe.calls.create.length, 1);
  assert.equal(stripe.calls.update.length, 0);
});

test("updates the existing endpoint when the exact secret is supplied", async () => {
  const stripe = stripeMock({ existing: [endpoint()] });
  const result = await ensureStripeWebhook({
    stripe,
    webhookUrl: WEBHOOK_URL,
    signingSecret: "whsec_existing_test",
    nowSeconds: NOW,
  });

  assert.equal(result.signingSecret, "whsec_existing_test");
  assert.equal(result.created, false);
  assert.equal(result.recovered, false);
  assert.equal(stripe.calls.create.length, 0);
  assert.equal(stripe.calls.update.length, 1);
  assert.equal(stripe.calls.update[0].input.disabled, false);
});

test("stops instead of creating a duplicate after the recovery window", async () => {
  const stripe = stripeMock({
    existing: [endpoint({ created: NOW - 24 * 60 * 60 })],
  });
  await assert.rejects(
    ensureStripeWebhook({ stripe, webhookUrl: WEBHOOK_URL, nowSeconds: NOW }),
    /add the exact STRIPE_WEBHOOK_SECRET/,
  );
  assert.equal(stripe.calls.create.length, 0);
  assert.equal(stripe.calls.update.length, 0);
});

test("does not replay-create an endpoint without the recovery marker", async () => {
  const stripe = stripeMock({
    existing: [endpoint({ metadata: {} })],
  });
  await assert.rejects(
    ensureStripeWebhook({ stripe, webhookUrl: WEBHOOK_URL, nowSeconds: NOW }),
    /not created by the recoverable setup/,
  );
  assert.equal(stripe.calls.create.length, 0);
});

test("does not take over a non-EPYHIA endpoint at the same URL", async () => {
  const stripe = stripeMock({
    existing: [endpoint({ description: "Another application" })],
  });
  await assert.rejects(
    ensureStripeWebhook({
      stripe,
      webhookUrl: WEBHOOK_URL,
      signingSecret: "whsec_unrelated_test",
      nowSeconds: NOW,
    }),
    /different description/,
  );
  assert.equal(stripe.calls.create.length, 0);
  assert.equal(stripe.calls.update.length, 0);
});

test("refuses duplicate endpoint records instead of guessing", async () => {
  const stripe = stripeMock({
    existing: [endpoint(), endpoint({ id: "we_duplicate_test" })],
  });
  await assert.rejects(
    ensureStripeWebhook({ stripe, webhookUrl: WEBHOOK_URL, nowSeconds: NOW }),
    /Multiple Stripe endpoints/,
  );
  assert.equal(stripe.calls.create.length, 0);
});
