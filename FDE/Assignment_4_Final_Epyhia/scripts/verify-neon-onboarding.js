import { NeonRepository } from "../src/gate/neon-repository.js";
import { OnboardingService } from "../src/gate/onboarding-service.js";
import { payloadHash } from "../src/shared/canonical.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const repository = new NeonRepository({ connectionString });
const service = new OnboardingService({ repository });
const input = {
  tenant: {
    id: "tenant_epyhia_verification_v1",
    name: "EPYHIA Verification",
    email: "verification@epyhia.invalid",
    businessName: "EPYHIA Verification Rental",
    businessSlug: "epyhia-verification-v1",
    businessEmail: "rental@epyhia.invalid",
    businessPhone: "+1-555-0100",
    businessAddress: "1 Verification Way",
  },
  originalBrief: "Fixed namespaced verification shell. No model call or external action.",
  approvedBudgetMicrodollars: 0,
  approvedBy: "epyhia-verifier",
  idempotencyKey: "epyhia-neon-onboarding-v1",
};

try {
  const first = await service.createRunShell(input);
  const second = await service.createRunShell(input);
  if (first.runId !== second.runId || second.replayed !== true) {
    throw new Error("Neon onboarding idempotency verification failed");
  }
  const mismatchedKey = "epyhia-neon-onboarding-contact-mismatch-v1";
  let contactMismatchRejected = false;
  try {
    await service.createRunShell({
      ...input,
      tenant: { ...input.tenant, businessPhone: "+1-555-9999" },
      idempotencyKey: mismatchedKey,
    });
  } catch (error) {
    contactMismatchRejected =
      error?.message === "Tenant identity is already bound to different business details";
  }
  const contactMismatchLeak = await repository.pool.query(
    `SELECT 1 FROM onboarding_requests
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [input.tenant.id, mismatchedKey],
  );
  if (!contactMismatchRejected || contactMismatchLeak.rowCount !== 0) {
    throw new Error("Neon tenant business binding verification failed");
  }
  const deployPayload = {
    projectName: "epyhia-verification-v1",
    files: { "index.html": "<!doctype html><title>EPYHIA verification</title>" },
  };
  const pendingInput = {
    tenantId: input.tenant.id,
    runId: first.runId,
    agentName: "web-builder",
    actionType: "deploy",
    payloadHash: payloadHash(deployPayload),
    idempotencyKey: "epyhia-neon-pending-deploy-v1",
    mode: "TEST",
    payload: deployPayload,
    approvalRequired: true,
  };
  const pending = await repository.createPendingAction(pendingInput);
  const pendingReplay = await repository.createPendingAction(pendingInput);
  if (
    pending.action.id !== pendingReplay.action.id ||
    pendingReplay.replayed !== true ||
    pendingReplay.action.status !== "PENDING_APPROVAL"
  ) {
    throw new Error("Neon pending-action idempotency verification failed");
  }
  let crossTenantApprovalRejected = false;
  try {
    await repository.approveAction({
      actionId: pending.action.id,
      payloadHash: pendingInput.payloadHash,
      approvedBy: "epyhia-verifier",
      tenantId: "tenant_epyhia_wrong_v1",
    });
  } catch (error) {
    crossTenantApprovalRejected =
      error?.message === "Approval action does not belong to this tenant";
  }
  const stillPending = await repository.requireAction(pending.action.id);
  if (!crossTenantApprovalRejected || stillPending.status !== "PENDING_APPROVAL") {
    throw new Error("Neon cross-tenant approval isolation verification failed");
  }
  let crossTenantModelCallRejected = false;
  try {
    await repository.reserveAgentCall({
      tenantId: "tenant_epyhia_wrong_v1",
      runId: first.runId,
      taskId: null,
      agentName: "strategist",
      modelId: "gpt-5.6-sol",
      modelTier: "sol",
      reservedCostMicrodollars: 0,
      idempotencyKey: "epyhia-cross-tenant-model-v1",
      requestHash: "0".repeat(64),
    });
  } catch (error) {
    crossTenantModelCallRejected =
      error?.message === "Run does not belong to the model-call tenant";
  }
  const modelCallLeak = await repository.pool.query(
    `SELECT 1 FROM agent_calls
     WHERE run_id = $1 AND agent_name = 'strategist'
       AND idempotency_key = 'epyhia-cross-tenant-model-v1'`,
    [first.runId],
  );
  if (!crossTenantModelCallRejected || modelCallLeak.rowCount !== 0) {
    throw new Error("Neon cross-tenant model-call isolation verification failed");
  }
  let crossTenantActionRejected = false;
  try {
    await repository.createPendingAction({
      ...pendingInput,
      tenantId: "tenant_epyhia_wrong_v1",
      idempotencyKey: "epyhia-cross-tenant-action-v1",
    });
  } catch (error) {
    crossTenantActionRejected = error?.message === "Run does not belong to the action tenant";
  }
  const actionLeak = await repository.pool.query(
    `SELECT 1 FROM actions
     WHERE run_id = $1 AND idempotency_key = 'epyhia-cross-tenant-action-v1'`,
    [first.runId],
  );
  if (!crossTenantActionRejected || actionLeak.rowCount !== 0) {
    throw new Error("Neon cross-tenant pending-action isolation verification failed");
  }
  const audit = await repository.readRunAudit({
    tenantId: input.tenant.id,
    runId: first.runId,
  });
  if (
    audit.runId !== first.runId ||
    !Number.isSafeInteger(audit.costs.totalCostMicrodollars) ||
    audit.actions.length < 2
  ) {
    throw new Error("Neon tenant-bound audit verification failed");
  }
  process.stdout.write("Neon deterministic run shell: created or found\n");
  process.stdout.write("Neon onboarding replay: same run verified\n");
  process.stdout.write("Neon tenant business details: immutable binding verified\n");
  process.stdout.write("Neon payload-bound pending action: same action verified\n");
  process.stdout.write("Neon cross-tenant approval: rejected without state change\n");
  process.stdout.write("Neon cross-tenant model call: rejected without state change\n");
  process.stdout.write("Neon cross-tenant pending action: rejected without state change\n");
  process.stdout.write("Neon tenant-bound audit and integer cost: verified\n");
} finally {
  await repository.close();
}
