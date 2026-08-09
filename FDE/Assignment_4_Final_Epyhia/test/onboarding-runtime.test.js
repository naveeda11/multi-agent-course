import assert from "node:assert/strict";
import { test } from "node:test";
import { OnboardingRuntime } from "../src/runtime/onboarding-runtime.js";

test("creates the deterministic run shell before the first Strategist inference", async () => {
  const events = [];
  const runtime = new OnboardingRuntime({
    controlGateClient: {
      async createRunShell(input) {
        events.push({ event: "shell", input });
        return { runId: "run_shell", status: "CREATED", replayed: false };
      },
    },
    strategist: {
      async createBusinessPlan(input) {
        events.push({ event: "strategist", input });
        return {
          status: "READY",
          clarificationQuestions: [],
          completedBrief: "Completed party-rental brief",
          brandDocument: "Grounded brand document",
          catalog: [
            {
              itemKey: "folding-chair",
              name: "Folding Chair",
              description: "White folding chair",
              availableQuantity: 100,
              dayRateCents: 300,
              currency: "usd",
            },
          ],
          taskPlan: [
            { taskType: "CATALOG_PERSIST" },
            { taskType: "WEB_BUILD" },
            { taskType: "MARKETING_PACK" },
          ],
        };
      },
    },
    ops: {
      async finalizeRun(input) {
        events.push({ event: "finalize", input });
        return { runId: input.runId, status: "EXECUTING", replayed: false };
      },
      async persistCatalog(input) {
        events.push({ event: "catalog", input });
        return { items: input.items, replayed: false };
      },
    },
  });

  const result = await runtime.onboard({
    tenant: {
      id: "tenant_test",
      name: "Tenant",
      email: "owner@example.test",
      businessName: "BrightDay Rentals",
      businessSlug: "brightday-rentals",
      businessEmail: "hello@example.test",
      businessPhone: "555-0100",
      businessAddress: "1 Main Street",
    },
    originalBrief: "Local party rentals",
    approvedBudgetMicrodollars: 1_000_000,
    approvedBy: "auth0|admin-test",
    idempotencyKey: "onboarding-1",
  });

  assert.deepEqual(events.map(({ event }) => event), [
    "shell",
    "strategist",
    "finalize",
    "catalog",
  ]);
  assert.equal(events[1].input.runId, "run_shell");
  assert.equal(events[1].input.tenant.businessEmail, "hello@example.test");
  assert.equal(events[1].input.tenant.businessAddress, "1 Main Street");
  assert.equal(events[1].input.idempotencyKey, "onboarding-1:strategist-plan:v1");
  assert.equal(events[0].input.approvedBy, "auth0|admin-test");
  assert.equal(events[2].input.runId, "run_shell");
  assert.equal(events[2].input.idempotencyKey, "onboarding-1:finalize");
  assert.equal(events[3].input.idempotencyKey, "onboarding-1:catalog");
  assert.equal(result.finalized.status, "EXECUTING");
  assert.equal(result.status, "EXECUTING");
});

test("returns clarification questions without finalizing or persisting catalog", async () => {
  let opsCalled = false;
  const runtime = new OnboardingRuntime({
    controlGateClient: {
      async createRunShell() {
        return { runId: "run_shell", status: "CREATED", replayed: false };
      },
    },
    strategist: {
      async createBusinessPlan() {
        return {
          status: "NEEDS_CLARIFICATION",
          clarificationQuestions: ["What is the daily chair price?"],
          completedBrief: "",
          brandDocument: "",
          catalog: [],
          taskPlan: [
            { taskType: "CATALOG_PERSIST" },
            { taskType: "WEB_BUILD" },
            { taskType: "MARKETING_PACK" },
          ],
        };
      },
    },
    ops: {
      async finalizeRun() {
        opsCalled = true;
      },
      async persistCatalog() {
        opsCalled = true;
      },
    },
  });

  const result = await runtime.onboard({
    tenant: {
      id: "tenant_test",
      name: "Tenant",
      email: "owner@example.test",
      businessName: "BrightDay Rentals",
      businessSlug: "brightday-rentals",
      businessEmail: "hello@example.test",
      businessPhone: "555-0100",
      businessAddress: "1 Main Street",
    },
    originalBrief: "Local party rentals",
    approvedBudgetMicrodollars: 1_000_000,
    approvedBy: "auth0|admin-test",
    idempotencyKey: "onboarding-2",
  });

  assert.equal(result.status, "AWAITING_CLARIFICATION");
  assert.equal(result.strategy.clarificationQuestions.length, 1);
  assert.equal(opsCalled, false);
});
