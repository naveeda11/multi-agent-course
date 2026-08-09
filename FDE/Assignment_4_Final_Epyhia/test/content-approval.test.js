import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionGate } from "../src/gate/action-gate.js";
import { ACTIONS, CapabilityRegistry } from "../src/gate/capabilities.js";
import { BrandWorkflow } from "../src/runtime/brand-workflow.js";
import { ApprovalRequiredError, AuthorizationError } from "../src/shared/errors.js";

test("Web Builder and Marketer cannot read an unapproved brand document", async () => {
  const gate = new ActionGate({
    repository: {
      async readRunContext() {
        return {
          brandDocument: { id: "brand_demo", approvalStatus: "PENDING" },
        };
      },
    },
    capabilities: new CapabilityRegistry([
      {
        handle: "web-context",
        subject: "web-builder",
        actions: [ACTIONS.READ_RUN_CONTEXT],
      },
      {
        handle: "admin-context",
        subject: "admin",
        actions: [ACTIONS.READ_RUN_CONTEXT],
      },
    ]),
  });
  await assert.rejects(
    gate.readRunContext({
      capabilityHandle: "web-context",
      agentName: "web-builder",
      tenantId: "tenant_demo",
      runId: "run_demo",
    }),
    ApprovalRequiredError,
  );
  const adminContext = await gate.readRunContext({
    capabilityHandle: "admin-context",
    agentName: "admin",
    tenantId: "tenant_demo",
    runId: "run_demo",
  });
  assert.equal(adminContext.brandDocument.approvalStatus, "PENDING");
});

test("brand and marketing approvals require their dedicated admin capabilities", async () => {
  const received = [];
  const gate = new ActionGate({
    repository: {},
    capabilities: new CapabilityRegistry([
      {
        handle: "admin-brand",
        subject: "admin",
        actions: [ACTIONS.APPROVE_BRAND_DOCUMENT],
      },
      {
        handle: "admin-marketing",
        subject: "admin",
        actions: [ACTIONS.APPROVE_MARKETING_PACK],
      },
    ]),
    onboardingService: {
      async approveBrandDocument(input) {
        received.push(["brand", input]);
        return { approvalStatus: "APPROVED" };
      },
    },
    marketingService: {
      async approvePack(input) {
        received.push(["marketing", input]);
        return { approvalStatus: "APPROVED" };
      },
    },
  });
  await assert.rejects(
    gate.approveBrandDocument({ capabilityHandle: "admin-marketing" }),
    AuthorizationError,
  );
  await gate.approveBrandDocument({
    capabilityHandle: "admin-brand",
    runId: "run_demo",
  });
  await gate.approveMarketingPack({
    capabilityHandle: "admin-marketing",
    runId: "run_demo",
  });
  assert.deepEqual(received.map(([kind]) => kind), ["brand", "marketing"]);
});

test("one brand approval automatically starts website and marketing generation", async () => {
  const calls = [];
  const workflow = new BrandWorkflow({
    adminGateClient: {
      async approveBrandDocument(input) {
        calls.push(["approve", input.idempotencyKey]);
        return { approvalStatus: "APPROVED" };
      },
    },
    webBuilder: {
      async buildAndRequestDeploy(input) {
        calls.push(["website", input.idempotencyKey]);
        return { deployment: { action: { id: "deploy_demo" } } };
      },
    },
    marketer: {
      async createAndPersistPack(input) {
        calls.push(["marketing", input.idempotencyKey]);
        return { persisted: { actionId: "marketing_demo" } };
      },
    },
  });
  const result = await workflow.approveAndGenerate({
    tenantId: "tenant_demo",
    runId: "run_demo",
    brandDocumentId: "brand_demo",
    contentHash: "a".repeat(64),
    approvedBy: "auth0|admin",
  });
  assert.equal(calls[0][0], "approve");
  assert.deepEqual(new Set(calls.slice(1).map(([kind]) => kind)), new Set(["website", "marketing"]));
  assert.deepEqual(calls.map(([, key]) => key), [
    "brand-approval:brand_demo",
    "web-build:run_demo",
    "marketing:run_demo",
  ]);
  assert.equal(result.generation.website.status, "COMPLETED");
  assert.equal(result.generation.marketing.status, "COMPLETED");
});

test("automatic generation reports one failed branch without hiding the other", async () => {
  const workflow = new BrandWorkflow({
    adminGateClient: {
      async approveBrandDocument() {
        return { approvalStatus: "APPROVED" };
      },
    },
    webBuilder: {
      async buildAndRequestDeploy() {
        throw new Error("website review failed");
      },
    },
    marketer: {
      async createAndPersistPack() {
        return { persisted: { actionId: "marketing_demo" } };
      },
    },
  });
  const result = await workflow.approveAndGenerate({
    tenantId: "tenant_demo",
    runId: "run_demo",
    brandDocumentId: "brand_demo",
    contentHash: "a".repeat(64),
    approvedBy: "auth0|admin",
  });
  assert.equal(result.generation.website.status, "FAILED");
  assert.equal(result.generation.website.error.message, "website review failed");
  assert.equal(result.generation.marketing.status, "COMPLETED");
});
