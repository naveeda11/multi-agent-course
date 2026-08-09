import assert from "node:assert/strict";
import { test } from "node:test";
import { MarketingService } from "../src/gate/marketing-service.js";
import { Marketer } from "../src/runtime/marketer.js";
import { ValidationError } from "../src/shared/errors.js";

const pack = {
  landingCopy: "BrightDay Rentals brings clean folding chairs to local celebrations.",
  socialPosts: [
    { channel: "instagram", text: "Plan the seats, then enjoy the party." },
    { channel: "facebook", text: "Local folding-chair rentals for your event." },
    { channel: "linkedin", text: "Reliable event seating for local teams." },
  ],
  launchEmail: "Subject: A simpler way to seat your next event\n\nReserve folding chairs online.",
  storyboard: {
    summary: "A quiet setup moment reveals clean folding chairs before guests arrive.",
    landscapePrompt: "Create a 4-second video with a slow dolly forward toward clean folding chairs being arranged in warm morning light. No text, logos, UI, or audio.",
    verticalPrompt: "Create a 4-second video with a slow crane down over clean folding chairs being arranged in warm morning light. No text, logos, UI, or audio.",
  },
};

const review = {
  status: "PASSED",
  feedback: [],
  checkedClaims: ["Folding chairs are present in the catalog."],
};

test("persists a complete grounded text pack with storyboard awaiting approval", async () => {
  const calls = [];
  const service = new MarketingService({
    repository: {
      async readRunContext() {
        return { catalog: [{ dayRateCents: 300, currency: "usd" }] };
      },
      async persistMarketingPack(input) {
        calls.push(input);
        return { actionId: "action_marketing", replayed: false };
      },
    },
  });
  const result = await service.persistPack({
    tenantId: "tenant_demo",
    runId: "run_demo",
    pack,
    review,
    idempotencyKey: "marketing-v1",
  });
  assert.equal(calls[0].pack.socialPosts.length, 3);
  assert.equal(calls[0].review.status, "PASSED");
  assert.equal(result.replayed, false);
});

test("rejects a marketing price not present in the authoritative catalog", async () => {
  let called = false;
  const service = new MarketingService({
    repository: {
      async readRunContext() {
        return { catalog: [{ dayRateCents: 300, currency: "usd" }] };
      },
      async persistMarketingPack() { called = true; },
    },
  });
  await assert.rejects(
    service.persistPack({
      tenantId: "tenant_demo",
      runId: "run_demo",
      pack: { ...pack, landingCopy: `${pack.landingCopy} Reserve for 4.00 USD per day.` },
      review,
      idempotencyKey: "marketing-price-v1",
    }),
    /price not found in the catalog/,
  );
  assert.equal(called, false);
});

test("rejects a pack before persistence when grounding review fails", async () => {
  let called = false;
  const service = new MarketingService({
    repository: {
      async persistMarketingPack() {
        called = true;
      },
    },
  });
  await assert.rejects(
    service.persistPack({
      tenantId: "tenant_demo",
      runId: "run_demo",
      pack,
      review: { ...review, status: "FAILED" },
      idempotencyKey: "marketing-v1",
    }),
    ValidationError,
  );
  assert.equal(called, false);
});

test("rejects storyboard prompts that contradict the fixed 4-second render", async () => {
  let called = false;
  const service = new MarketingService({
    repository: {
      async persistMarketingPack() { called = true; },
    },
  });
  await assert.rejects(
    service.persistPack({
      tenantId: "tenant_demo",
      runId: "run_demo",
      pack: {
        ...pack,
        storyboard: {
          ...pack.storyboard,
          landscapePrompt: "Create a cinematic 12-second video. No text or audio.",
        },
      },
      review,
      idempotencyKey: "marketing-duration-v1",
    }),
    /must request exactly a 4-second video/,
  );
  assert.equal(called, false);
});

test("Marketer performs a separate grounding review before Gate persistence", async () => {
  const calls = [];
  const marketer = new Marketer({
    gateClient: {
      async readRunContext() {
        return {
          tasks: [{ id: "task_marketing", taskType: "MARKETING_PACK" }],
          catalog: [{ name: "Folding Chair", dayRateCents: 300, currency: "usd" }],
        };
      },
      async modelCall(input) {
        calls.push(input);
        return {
          callId: `call_${calls.length}`,
          outputText: JSON.stringify(calls.length === 1 ? pack : review),
        };
      },
      async persistMarketingPack(input) {
        calls.push(input);
        return { actionId: "action_marketing", replayed: false };
      },
    },
  });
  const result = await marketer.createAndPersistPack({
    tenantId: "tenant_demo",
    runId: "run_demo",
    idempotencyKey: "marketing-v1",
    revisionFeedback: ["Shorten the launch email"],
  });
  assert.deepEqual(JSON.parse(calls[0].input).revisionFeedback, [
    "Shorten the launch email",
  ]);
  assert.equal(calls[0].idempotencyKey, "marketing-v1:draft:v1");
  assert.match(calls[0].instructions, /generic illustrative example/);
  assert.match(calls[0].instructions, /no claimed filming, storage, or business-premises location/);
  assert.match(calls[0].instructions, /exactly two 4-second moving videos/);
  assert.match(calls[1].instructions, /exactly 4 seconds/);
  assert.equal(calls[1].idempotencyKey, "marketing-v1:review:v1");
  assert.equal(calls[2].idempotencyKey, "marketing-v1:persist");
  assert.equal(result.review.status, "PASSED");
});
