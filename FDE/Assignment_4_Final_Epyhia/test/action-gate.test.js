import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ActionGate } from "../src/gate/action-gate.js";
import { ACTIONS, CapabilityRegistry } from "../src/gate/capabilities.js";
import { GateRepository } from "../src/gate/repository.js";
import {
  ApprovalRequiredError,
  AuthenticationError,
  ConflictError,
  ProviderError,
} from "../src/shared/errors.js";
import { sha256 } from "../src/shared/canonical.js";

const WEB_HANDLE = "test-web-builder-handle";
const ADMIN_HANDLE = "test-admin-handle";

class FakeDeploymentProvider {
  constructor({ failuresBeforeSuccess = 0 } = {}) {
    this.mode = "TEST";
    this.failuresBeforeSuccess = failuresBeforeSuccess;
    this.deployCalls = 0;
    this.verifyCalls = 0;
    this.lastVerification = null;
  }

  async deploy({ projectName }) {
    this.deployCalls += 1;
    if (this.deployCalls <= this.failuresBeforeSuccess) {
      throw new ProviderError("Synthetic deploy failure");
    }
    return {
      liveUrl: `https://${projectName}.example.test`,
      providerReference: `provider-${this.deployCalls}`,
      providerCostMicrodollars: 0,
    };
  }

  async verify(liveUrl, input) {
    this.verifyCalls += 1;
    this.lastVerification = { liveUrl, ...input };
    return true;
  }
}

function buildHarness(provider = new FakeDeploymentProvider()) {
  const repository = new GateRepository();
  const tenant = repository.createTenant({
    id: "tenant_demo",
    name: "Demo Tenant",
    businessSlug: "party-rentals",
  });
  const run = repository.createRun({
    id: "run_demo",
    tenantId: tenant.id,
    originalBrief: "Local party rentals",
    briefHash: sha256("Local party rentals"),
    approvedBudgetMicrodollars: 1_000_000,
  });
  const capabilities = new CapabilityRegistry([
    { handle: WEB_HANDLE, subject: "web-builder", actions: [ACTIONS.DEPLOY] },
    {
      handle: ADMIN_HANDLE,
      subject: "admin",
      actions: [
        ACTIONS.APPROVE,
        ACTIONS.READ_AUDIT,
        ACTIONS.READ_RUN_AUDIT,
        ACTIONS.READ_TENANT_PROFILE,
      ],
    },
  ]);
  const gate = new ActionGate({
    repository,
    capabilities,
    deploymentProvider: provider,
  });
  return { gate, repository, provider, tenant, run };
}

function deployRequest(overrides = {}) {
  return {
    capabilityHandle: WEB_HANDLE,
    tenantId: "tenant_demo",
    runId: "run_demo",
    agentName: "web-builder",
    idempotencyKey: "deploy-run-demo-v1",
    mode: "TEST",
    payload: {
      projectName: "party-rentals-demo",
      files: {
        "index.html": "<!doctype html><title>Party Rentals</title>",
        "styles.css": "body { color: #222; }",
      },
    },
    ...overrides,
  };
}

describe("Action Gate deploy vertical slice", () => {
  let harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  afterEach(() => {
    harness.repository.close();
  });

  test("requires payload-bound approval, executes once, and returns the audit replay", async () => {
    const requested = await harness.gate.requestDeploy(deployRequest());
    assert.equal(requested.replayed, false);
    assert.equal(requested.action.status, "PENDING_APPROVAL");
    assert.equal(requested.action.approvalStatus, "PENDING");

    await assert.rejects(
      harness.gate.executeDeploy({
        capabilityHandle: WEB_HANDLE,
        actionId: requested.action.id,
        agentName: "web-builder",
      }),
      ApprovalRequiredError,
    );
    assert.equal(harness.provider.deployCalls, 0);

    await assert.rejects(
      harness.gate.approve({
          capabilityHandle: ADMIN_HANDLE,
          actionId: requested.action.id,
          payloadHash: "0".repeat(64),
          approvedBy: "admin",
          tenantId: "tenant_demo",
        }),
      ConflictError,
    );

    const approved = await harness.gate.approve({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    assert.equal(approved.status, "APPROVED");

    const executed = await harness.gate.executeDeploy({
      capabilityHandle: WEB_HANDLE,
      actionId: requested.action.id,
      agentName: "web-builder",
    });
    assert.equal(executed.action.status, "EXECUTED");
    assert.equal(executed.action.providerCostMicrodollars, 0);
    assert.equal(executed.deployment.liveUrl, "https://party-rentals-demo.example.test");
    assert.equal(harness.provider.deployCalls, 1);
    assert.equal(
      harness.provider.lastVerification.expectedContentHash,
      sha256(deployRequest().payload.files["index.html"]),
    );
    assert.ok(executed.action.executedAt);

    const replayedRequest = await harness.gate.requestDeploy(deployRequest());
    assert.equal(replayedRequest.replayed, true);
    assert.equal(replayedRequest.action.id, requested.action.id);

    const replayedExecution = await harness.gate.executeDeploy({
      capabilityHandle: WEB_HANDLE,
      actionId: requested.action.id,
      agentName: "web-builder",
    });
    assert.equal(replayedExecution.replayed, true);
    assert.equal(
      replayedExecution.deployment.liveUrl,
      "https://party-rentals-demo.example.test",
    );
    assert.equal(harness.provider.deployCalls, 1);

    const deployment = harness.repository.getDeployment("tenant_demo");
    assert.equal(deployment.last_action_id, requested.action.id);
    assert.equal(deployment.cloudflare_project_name, "party-rentals-demo");
    assert.ok(deployment.verified_at);
  });

  test("recovers a stale deployment claim without creating another site", async () => {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await harness.gate.approve({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    const firstClaim = harness.repository.claimForExecution(requested.action.id);
    assert.equal(firstClaim.claimed, true);
    harness.repository.db
      .prepare("UPDATE actions SET execution_started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", requested.action.id);

    const executed = await harness.gate.executeDeploy({
      capabilityHandle: WEB_HANDLE,
      actionId: requested.action.id,
      agentName: "web-builder",
    });

    assert.equal(executed.action.status, "EXECUTED");
    assert.equal(harness.provider.deployCalls, 1);
    assert.equal(
      harness.repository.getDeployment("tenant_demo").cloudflare_project_name,
      "party-rentals-demo",
    );
  });

  test("requires fresh approval instead of replaying stale paid-video execution", () => {
    const requested = harness.repository.createPendingAction({
      tenantId: "tenant_demo",
      runId: "run_demo",
      agentName: "marketer",
      actionType: "video-render",
      payloadHash: "a".repeat(64),
      idempotencyKey: "video-run-demo-v1",
      mode: "LIVE",
      payload: { estimatedCostMicrodollars: 640_000 },
      approvalRequired: true,
    });
    harness.repository.approveAction({
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    harness.repository.claimForExecution(requested.action.id);
    harness.repository.db
      .prepare("UPDATE actions SET execution_started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", requested.action.id);

    const recovered = harness.repository.claimForExecution(requested.action.id);

    assert.equal(recovered.claimed, false);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.action.status, "FAILED");
    assert.equal(recovered.action.approvalStatus, "PENDING");
    assert.equal(recovered.action.approvedBy, null);
    assert.match(recovered.action.failureMessage, /fresh administrator approval/);
  });

  test("rejects an approval from a different authenticated tenant", async () => {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await assert.rejects(
      harness.gate.approve({
        capabilityHandle: ADMIN_HANDLE,
        actionId: requested.action.id,
        payloadHash: requested.action.payloadHash,
        approvedBy: "auth0|other-admin",
        tenantId: "tenant_other",
      }),
      ConflictError,
    );
    assert.equal(harness.repository.requireAction(requested.action.id).approvalStatus, "PENDING");
  });

  test("rejects a pending action whose run belongs to another tenant", async () => {
    const otherTenant = harness.repository.createTenant({
      id: "tenant_other",
      name: "Other Tenant",
      businessSlug: "other-rentals",
    });
    harness.repository.createRun({
      id: "run_other",
      tenantId: otherTenant.id,
      originalBrief: "Other rentals",
      briefHash: sha256("Other rentals"),
    });
    await assert.rejects(
      harness.gate.requestDeploy(deployRequest({ runId: "run_other" })),
      /Run does not belong to the action tenant/,
    );
    assert.equal(harness.repository.getDeployment("tenant_demo"), undefined);
  });

  test("rejects idempotency-key reuse with a different payload", async () => {
    await harness.gate.requestDeploy(deployRequest());
    await assert.rejects(
      harness.gate.requestDeploy(
          deployRequest({
            payload: {
              projectName: "party-rentals-demo",
              files: { "index.html": "<title>Changed after approval</title>" },
            },
          }),
        ),
      ConflictError,
    );
  });

  test("rejects missing and cross-agent capability handles", async () => {
    await assert.rejects(
      harness.gate.requestDeploy(deployRequest({ capabilityHandle: "" })),
      AuthenticationError,
    );
    await assert.rejects(
      harness.gate.requestDeploy(
          deployRequest({ capabilityHandle: ADMIN_HANDLE }),
        ),
      (error) => error.code === "FORBIDDEN",
    );
  });

  test("requires an audit capability to read an action", async () => {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await assert.rejects(
      harness.gate.readAudit({
          capabilityHandle: WEB_HANDLE,
          actionId: requested.action.id,
          subject: "web-builder",
        }),
      (error) => error.code === "FORBIDDEN",
    );
    const audit = await harness.gate.readAudit({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      subject: "admin",
    });
    assert.equal(audit.id, requested.action.id);
  });

  test("requires the admin capability and tenant binding to read a run audit", async () => {
    const received = [];
    harness.repository.readRunAudit = async (input) => {
      received.push(input);
      return { runId: input.runId, costs: { totalCostMicrodollars: 0 } };
    };
    await assert.rejects(
      harness.gate.readRunAudit({
        capabilityHandle: WEB_HANDLE,
        tenantId: "tenant_demo",
        runId: "run_demo",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const audit = await harness.gate.readRunAudit({
      capabilityHandle: ADMIN_HANDLE,
      tenantId: "tenant_demo",
      runId: "run_demo",
    });
    assert.equal(audit.runId, "run_demo");
    assert.deepEqual(received[0], { tenantId: "tenant_demo", runId: "run_demo" });
  });

  test("requires the admin capability to read the bound tenant profile", async () => {
    harness.repository.readTenantProfile = async ({ tenantId }) => ({
      tenantId,
      businessName: "Demo Tenant",
    });
    await assert.rejects(
      harness.gate.readTenantProfile({
        capabilityHandle: WEB_HANDLE,
        tenantId: "tenant_demo",
      }),
      (error) => error.code === "FORBIDDEN",
    );
    const profile = await harness.gate.readTenantProfile({
      capabilityHandle: ADMIN_HANDLE,
      tenantId: "tenant_demo",
    });
    assert.equal(profile.businessName, "Demo Tenant");
  });

  test("keeps one stable deployment project per tenant", async () => {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await assert.rejects(
      harness.gate.requestDeploy(
          deployRequest({
            idempotencyKey: "deploy-run-demo-v2",
            payload: {
              projectName: "an-unapproved-second-project",
              files: { "index.html": "<title>Second project</title>" },
            },
          }),
        ),
      ConflictError,
    );
    await harness.gate.approve({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    await harness.gate.executeDeploy({
      capabilityHandle: WEB_HANDLE,
      actionId: requested.action.id,
      agentName: "web-builder",
    });

    await assert.rejects(
      harness.gate.requestDeploy(
          deployRequest({
            idempotencyKey: "deploy-run-demo-v2",
            payload: {
              projectName: "an-unapproved-second-project",
              files: { "index.html": "<title>Second project</title>" },
            },
          }),
        ),
      ConflictError,
    );
  });
});

test("a failed provider call is retried once before execution is recorded", async () => {
  const provider = new FakeDeploymentProvider({ failuresBeforeSuccess: 1 });
  const harness = buildHarness(provider);
  try {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await harness.gate.approve({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    const result = await harness.gate.executeDeploy({
      capabilityHandle: WEB_HANDLE,
      actionId: requested.action.id,
      agentName: "web-builder",
    });
    assert.equal(result.action.status, "EXECUTED");
    assert.equal(provider.deployCalls, 2);
  } finally {
    harness.repository.close();
  }
});

test("two provider failures leave an auditable failed action", async () => {
  const provider = new FakeDeploymentProvider({ failuresBeforeSuccess: 2 });
  const harness = buildHarness(provider);
  try {
    const requested = await harness.gate.requestDeploy(deployRequest());
    await harness.gate.approve({
      capabilityHandle: ADMIN_HANDLE,
      actionId: requested.action.id,
      payloadHash: requested.action.payloadHash,
      approvedBy: "admin",
      tenantId: "tenant_demo",
    });
    await assert.rejects(
      harness.gate.executeDeploy({
        capabilityHandle: WEB_HANDLE,
        actionId: requested.action.id,
        agentName: "web-builder",
      }),
      /failure is logged for administrator review/,
    );
    const failed = harness.repository.requireAction(requested.action.id);
    assert.equal(failed.status, "FAILED");
    assert.match(failed.failureMessage, /Synthetic deploy failure/);
    assert.equal(provider.deployCalls, 2);
  } finally {
    harness.repository.close();
  }
});
