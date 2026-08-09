import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CheckoutService } from "../src/gate/checkout-service.js";
import { ConflictError, ValidationError } from "../src/shared/errors.js";

const checkoutInput = {
  siteOrigin: "https://rentals.example.test",
  customer: { name: "Demo Customer", email: "customer@example.test" },
  startDate: "2026-09-01",
  endDate: "2026-09-03",
  items: [{ itemId: "item_chairs", quantity: 10 }],
  successUrl: "https://rentals.example.test/checkout/success",
  cancelUrl: "https://rentals.example.test/checkout/cancel",
  idempotencyKey: "purchase-demo-1",
};

function reservation(overrides = {}) {
  return {
    tenantId: "tenant_demo",
    runId: "run_demo",
    actionId: "action_checkout",
    reservationId: "reservation_demo",
    totalCents: 1_000,
    currency: "usd",
    checkoutSessionId: null,
    checkoutUrl: null,
    lineItems: [
      {
        itemId: "item_chairs",
        name: "Folding Chair",
        description: "White folding chair",
        quantity: 10,
        dayRateCents: 50,
        rentalDays: 2,
        unitAmountCents: 100,
      },
    ],
    replayed: false,
    ...overrides,
  };
}

describe("Stripe sandbox checkout service", () => {
  test("uses the authoritative reservation total and a reservation-derived Stripe key", async () => {
    const events = [];
    const service = new CheckoutService({
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      repository: {
        async createCheckoutReservation(input) {
          events.push({ type: "reserve", input });
          return reservation();
        },
        async completeCheckoutSession(input) {
          events.push({ type: "complete", input });
        },
        async failAction() {
          assert.fail("checkout should not fail");
        },
      },
      provider: {
        async createCheckoutSession(input) {
          events.push({ type: "stripe", input });
          return {
            id: "cs_test_demo",
            url: "https://checkout.stripe.com/c/pay/demo",
            amountTotal: 1_000,
            currency: "usd",
            expiresAt: 1786213200,
            livemode: false,
          };
        },
      },
    });

    const result = await service.createSession({
      ...checkoutInput,
      totalCents: 1,
      currency: "eur",
    });

    assert.equal(events[1].input.idempotencyKey, "checkout:reservation_demo");
    assert.equal(events[1].input.lineItems[0].unitAmountCents, 100);
    assert.equal(events[1].input.currency, "usd");
    assert.equal(result.totalCents, 1_000);
    assert.equal(result.currency, "usd");
    assert.equal(events[2].type, "complete");
  });

  test("returns a persisted Checkout Session replay without calling Stripe", async () => {
    let stripeCalls = 0;
    const service = new CheckoutService({
      repository: {
        async createCheckoutReservation() {
          return reservation({
            checkoutSessionId: "cs_test_existing",
            checkoutUrl: "https://checkout.stripe.com/c/pay/existing",
            replayed: true,
          });
        },
      },
      provider: {
        async createCheckoutSession() {
          stripeCalls += 1;
        },
      },
    });

    const result = await service.createSession(checkoutInput);
    assert.equal(result.replayed, true);
    assert.equal(result.checkoutSessionId, "cs_test_existing");
    assert.equal(stripeCalls, 0);
  });

  test("rejects a live-mode provider result and records the failed action", async () => {
    const failures = [];
    const service = new CheckoutService({
      repository: {
        async createCheckoutReservation() {
          return reservation();
        },
        async failAction(actionId, message) {
          failures.push({ actionId, message });
        },
      },
      provider: {
        async createCheckoutSession() {
          return {
            id: "cs_live_forbidden",
            url: "https://checkout.stripe.com/live",
            amountTotal: 1_000,
            currency: "usd",
            expiresAt: 1786213200,
            livemode: true,
          };
        },
      },
    });

    await assert.rejects(service.createSession(checkoutInput), ConflictError);
    assert.equal(failures[0].actionId, "action_checkout");
  });

  test("rejects a non-Stripe checkout URL before persistence", async () => {
    const failures = [];
    const service = new CheckoutService({
      repository: {
        async createCheckoutReservation() { return reservation(); },
        async failAction(actionId, message) { failures.push({ actionId, message }); },
      },
      provider: {
        async createCheckoutSession() {
          return {
            id: "cs_test_demo",
            url: "https://attacker.example/checkout",
            amountTotal: 1_000,
            currency: "usd",
            expiresAt: 1786213200,
            livemode: false,
          };
        },
      },
    });
    await assert.rejects(service.createSession(checkoutInput), ConflictError);
    assert.equal(failures.length, 1);
  });

  test("verifies webhook signatures before delegating persistence", async () => {
    const rawBody = Buffer.from('{"id":"evt_test"}');
    const events = [];
    const service = new CheckoutService({
      provider: {
        constructWebhookEvent(body, signature) {
          events.push({ body, signature });
          return {
            id: "evt_test",
            type: "checkout.session.completed",
            livemode: false,
          };
        },
      },
      repository: {
        async processStripeWebhook({ event }) {
          events.push({ event });
          return { eventId: event.id, replayed: false };
        },
      },
    });

    const result = await service.processWebhook({
      rawBody,
      signature: "t=1,v1=test",
    });
    assert.equal(events[0].body, rawBody);
    assert.equal(events[0].signature, "t=1,v1=test");
    assert.equal(events[1].event.id, "evt_test");
    assert.equal(result.replayed, false);
  });

  test("rejects mismatched return origins before reserving inventory", async () => {
    let repositoryCalled = false;
    const service = new CheckoutService({
      repository: {
        async createCheckoutReservation() {
          repositoryCalled = true;
        },
      },
      provider: {},
    });
    await assert.rejects(
      service.createSession({
        ...checkoutInput,
        successUrl: "https://attacker.example/success",
      }),
      ValidationError,
    );
    assert.equal(repositoryCalled, false);
  });

  test("rejects an unbounded rental period before touching persistence", async () => {
    let repositoryCalls = 0;
    const service = new CheckoutService({
      repository: {
        async createCheckoutReservation() { repositoryCalls += 1; },
      },
      provider: {},
    });
    await assert.rejects(
      service.createSession({
        ...checkoutInput,
        startDate: "2026-09-01",
        endDate: "2027-09-02",
      }),
      /between 1 and 365 days/,
    );
    assert.equal(repositoryCalls, 0);
  });
});
