import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalCoordinator } from "../src/runtime/approval-coordinator.js";

test("an explicit admin approval precedes Web Builder deployment execution", async () => {
  const order = [];
  const coordinator = new ApprovalCoordinator({
    adminGateClient: {
      async approveAction(input) {
        order.push({ operation: "approve", ...input });
        return { action: { status: "APPROVED" } };
      },
    },
    webBuilderGateClient: {
      async executeDeploy(actionId) {
        order.push({ operation: "execute", actionId });
        return { action: { status: "EXECUTED" } };
      },
    },
  });
  const result = await coordinator.approveAndExecuteDeployment({
    actionId: "action_demo",
    payloadHash: "a".repeat(64),
    approvedBy: "auth0|admin",
    tenantId: "tenant_demo",
  });
  assert.deepEqual(order.map((entry) => entry.operation), ["approve", "execute"]);
  assert.equal(order[0].approvedBy, "auth0|admin");
  assert.equal(order[0].tenantId, "tenant_demo");
  assert.equal(result.execution.action.status, "EXECUTED");
});

test("an explicit admin approval precedes paid video execution", async () => {
  const order = [];
  const coordinator = new ApprovalCoordinator({
    adminGateClient: {
      async approveAction() { order.push("approve"); return { action: { status: "APPROVED" } }; },
    },
    marketerGateClient: {
      async executeVideoRender() { order.push("render"); return { action: { status: "EXECUTED" } }; },
    },
  });
  const result = await coordinator.approveAndExecuteVideo({
    actionId: "action_video",
    payloadHash: "b".repeat(64),
    approvedBy: "auth0|admin",
    tenantId: "tenant_demo",
  });
  assert.deepEqual(order, ["approve", "render"]);
  assert.equal(result.execution.action.status, "EXECUTED");
});
