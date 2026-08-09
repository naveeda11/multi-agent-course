import assert from "node:assert/strict";
import { test } from "node:test";
import { OnboardingService } from "../src/gate/onboarding-service.js";

const tenant = {
  id: "tenant_test",
  name: "Tenant Owner",
  email: "owner@example.test",
  businessName: "BrightDay Rentals",
  businessSlug: "brightday-rentals",
  businessEmail: "hello@example.test",
  businessPhone: "555-0100",
  businessAddress: "1 Main Street",
};

test("run-shell creation is a direct repository action with no model dependency", async () => {
  const calls = [];
  const service = new OnboardingService({
    repository: {
      async createRunShell(input) {
        calls.push(input);
        return { runId: "run_test", status: "CREATED" };
      },
    },
  });
  const result = await service.createRunShell({
    tenant,
    originalBrief: "Local rentals",
    approvedBudgetMicrodollars: 1_000_000,
    approvedBy: "auth0|admin-test",
    idempotencyKey: "onboarding-1",
  });
  assert.equal(result.runId, "run_test");
  assert.equal(calls.length, 1);
});

test("Tier 3 rejects a run budget above the authorized two-dollar cap", async () => {
  let called = false;
  const service = new OnboardingService({
    repository: {
      async createRunShell() {
        called = true;
      },
    },
  });
  await assert.rejects(
    service.createRunShell({
      tenant,
      originalBrief: "Local rentals",
      approvedBudgetMicrodollars: 2_000_001,
      approvedBy: "auth0|admin-test",
      idempotencyKey: "onboarding-over-budget",
    }),
    /between 0 and 2,000,000/,
  );
  assert.equal(called, false);
});

test("finalization rejects duplicate task types before persistence", async () => {
  let called = false;
  const service = new OnboardingService({
    repository: {
      async finalizeRun() {
        called = true;
      },
    },
  });
  await assert.rejects(
    service.finalizeRun({
      tenantId: tenant.id,
      runId: "run_test",
      completedBrief: "Completed brief",
      brandDocument: "Brand document",
      idempotencyKey: "finalize-1",
      taskPlan: [
        { taskType: "WEB_BUILD" },
        { taskType: "WEB_BUILD" },
      ],
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  assert.equal(called, false);
});

test("finalization rejects an incomplete task plan before persistence", async () => {
  let called = false;
  const service = new OnboardingService({
    repository: {
      async finalizeRun() {
        called = true;
      },
    },
  });
  await assert.rejects(
    service.finalizeRun({
      tenantId: "tenant_test",
      runId: "run_test",
      completedBrief: "Complete grounded brief",
      brandDocument: "Grounded brand document",
      taskPlan: [{ taskType: "WEB_BUILD" }],
      idempotencyKey: "finalize-test",
    }),
    /exactly the three required tasks/,
  );
  assert.equal(called, false);
});
