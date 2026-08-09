import assert from "node:assert/strict";
import { test } from "node:test";
import { Strategist } from "../src/runtime/strategist.js";

const input = {
  tenantId: "tenant_demo",
  runId: "run_demo",
  tenant: {
    businessName: "BrightDay Rentals",
    businessSlug: "brightday-rentals",
    businessEmail: "hello@example.test",
    businessPhone: "555-0100",
    businessAddress: "1 Main Street",
  },
  originalBrief: "Local party rentals without catalog prices.",
  idempotencyKey: "strategy-demo-v1",
};

test("Strategist supplies authoritative tenant facts and keeps clarification output provisional", async () => {
  let request;
  const strategist = new Strategist({
    modelGateway: {
      async modelCall(value) {
        request = value;
        return {
          outputText: JSON.stringify({
            status: "NEEDS_CLARIFICATION",
            clarificationQuestions: ["What is the daily chair rate and currency?"],
            completedBrief: "",
            brandDocument: "",
            catalog: [],
            taskPlan: [],
          }),
        };
      },
    },
  });

  const result = await strategist.createBusinessPlan(input);

  assert.equal(result.status, "NEEDS_CLARIFICATION");
  assert.equal(request.responseSchema.schema.properties.taskPlan.minItems, 0);
  assert.equal(JSON.parse(request.input).tenant.businessEmail, "hello@example.test");
});

test("Strategist rejects finalized outputs smuggled into a clarification response", async () => {
  const strategist = new Strategist({
    modelGateway: {
      async modelCall() {
        return {
          outputText: JSON.stringify({
            status: "NEEDS_CLARIFICATION",
            clarificationQuestions: ["What is the daily rate?"],
            completedBrief: "Premature brief",
            brandDocument: "",
            catalog: [],
            taskPlan: [],
          }),
        };
      },
    },
  });

  await assert.rejects(
    strategist.createBusinessPlan(input),
    /must not contain premature finalized outputs/,
  );
});
