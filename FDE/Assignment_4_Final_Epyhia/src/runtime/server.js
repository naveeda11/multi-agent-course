import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { bearer, readJson, readRaw, send, sendError } from "../gate/http.js";
import { AuthenticationError, NotFoundError } from "../shared/errors.js";
import { loadRuntimeDependencies } from "./config.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function validateTier1Capability(value) {
  if (!/^[A-Za-z0-9]{32,200}$/.test(value ?? "")) {
    throw new Error(
      "TIER1_RUNTIME_CAPABILITY_HANDLE must be 32-200 alphanumeric characters",
    );
  }
  return value;
}

function requireTier1Capability(request, expected) {
  const received = bearer(request);
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  if (
    receivedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(receivedBytes, expectedBytes)
  ) {
    throw new AuthenticationError("A valid Tier 1 capability handle is required");
  }
}

export function createRuntimeServer({
  onboardingRuntime,
  ops,
  marketer,
  webBuilder,
  approvalCoordinator,
  runStatusReader,
  runAuditReader,
  tenantProfileReader,
  tenantEraser,
  brandWorkflow,
  tier1CapabilityHandle,
}) {
  const expectedTier1Capability = validateTier1Capability(tier1CapabilityHandle);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://runtime.internal");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok", tier: 2 });
      }
      if (url.pathname.startsWith("/v1/")) {
        requireTier1Capability(request, expectedTier1Capability);
      }
      if (request.method === "POST" && url.pathname === "/v1/onboarding") {
        const body = await readJson(request);
        const result = await onboardingRuntime.onboard({
          tenant: body.tenant,
          originalBrief: body.originalBrief,
          approvedBudgetMicrodollars: body.approvedBudgetMicrodollars,
          approvedBy: body.approvedBy,
          idempotencyKey: request.headers["idempotency-key"],
          clarificationAnswers: body.clarificationAnswers,
          clarificationRound: body.clarificationRound,
        });
        return send(response, result.shell.replayed ? 200 : 201, result);
      }
      if (request.method === "POST" && url.pathname === "/v1/checkout-session") {
        const body = await readJson(request);
        const result = await ops.createCheckoutSession({
          ...body,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }
      const runStatusMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/status$/);
      if (request.method === "GET" && runStatusMatch) {
        const context = await runStatusReader.readRunContext({
          tenantId: url.searchParams.get("tenantId"),
          runId: decodeURIComponent(runStatusMatch[1]),
        });
        return send(response, 200, {
          runId: context.runId,
          status: context.runStatus,
          completedBrief: context.completedBrief,
          brandDocument: context.brandDocument,
          tasks: context.tasks,
        });
      }
      const runAuditMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/audit$/);
      if (request.method === "GET" && runAuditMatch) {
        return send(
          response,
          200,
          await runAuditReader.readRunAudit({
            tenantId: url.searchParams.get("tenantId"),
            runId: decodeURIComponent(runAuditMatch[1]),
          }),
        );
      }
      const tenantProfileMatch = url.pathname.match(
        /^\/v1\/tenants\/([^/]+)\/profile$/,
      );
      if (request.method === "GET" && tenantProfileMatch) {
        return send(
          response,
          200,
          await tenantProfileReader.readTenantProfile({
            tenantId: decodeURIComponent(tenantProfileMatch[1]),
          }),
        );
      }
      if (request.method === "DELETE" && tenantProfileMatch) {
        const body = await readJson(request);
        return send(
          response,
          200,
          await tenantEraser.eraseTenant({
            tenantId: decodeURIComponent(tenantProfileMatch[1]),
            auth0UserId: body.auth0UserId,
            confirmation: body.confirmation,
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/v1/stripe/webhook") {
        const result = await ops.processStripeWebhook({
          rawBody: await readRaw(request),
          signature: request.headers["stripe-signature"],
        });
        return send(response, 200, result);
      }
      const marketingMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/marketing$/);
      if (request.method === "POST" && marketingMatch) {
        const body = await readJson(request);
        const result = await marketer.createAndPersistPack({
          tenantId: body.tenantId,
          runId: decodeURIComponent(marketingMatch[1]),
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.persisted.replayed ? 200 : 201, result);
      }
      const brandGenerationMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/brand-document\/approve-and-generate$/,
      );
      if (request.method === "POST" && brandGenerationMatch) {
        const body = await readJson(request);
        const result = await brandWorkflow.approveAndGenerate({
          tenantId: body.tenantId,
          runId: decodeURIComponent(brandGenerationMatch[1]),
          brandDocumentId: body.brandDocumentId,
          contentHash: body.contentHash,
          approvedBy: body.approvedBy,
        });
        return send(response, 200, result);
      }
      const brandApprovalMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/brand-document\/approve$/,
      );
      if (request.method === "POST" && brandApprovalMatch) {
        const body = await readJson(request);
        const result = await brandWorkflow.approveBrandDocument({
          tenantId: body.tenantId,
          runId: decodeURIComponent(brandApprovalMatch[1]),
          brandDocumentId: body.brandDocumentId,
          contentHash: body.contentHash,
          approvedBy: body.approvedBy,
        });
        return send(response, 200, result);
      }
      const artifactRevisionMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/artifact-revision$/,
      );
      if (request.method === "POST" && artifactRevisionMatch) {
        const body = await readJson(request);
        const result = await brandWorkflow.reviseArtifact({
          tenantId: body.tenantId,
          sourceRunId: decodeURIComponent(artifactRevisionMatch[1]),
          artifactType: body.artifactType,
          feedback: body.feedback,
          approvedBudgetMicrodollars: body.approvedBudgetMicrodollars,
          approvedBy: body.approvedBy,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.revision.replayed ? 200 : 201, result);
      }
      const marketingPackApprovalMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/marketing-pack\/approve$/,
      );
      if (request.method === "POST" && marketingPackApprovalMatch) {
        const body = await readJson(request);
        const result = await brandWorkflow.approveMarketingPack({
          tenantId: body.tenantId,
          runId: decodeURIComponent(marketingPackApprovalMatch[1]),
          packHash: body.packHash,
          approvedBy: body.approvedBy,
        });
        return send(response, 200, result);
      }
      const webBuildMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/web-build$/);
      if (request.method === "POST" && webBuildMatch) {
        const body = await readJson(request);
        const result = await webBuilder.buildAndRequestDeploy({
          tenantId: body.tenantId,
          runId: decodeURIComponent(webBuildMatch[1]),
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.persisted.replayed ? 200 : 202, result);
      }
      const approvalMatch = url.pathname.match(
        /^\/v1\/actions\/([^/]+)\/approve-and-execute$/,
      );
      if (request.method === "POST" && approvalMatch) {
        const body = await readJson(request);
        const result = await approvalCoordinator.approveAndExecuteDeployment({
          actionId: decodeURIComponent(approvalMatch[1]),
          payloadHash: body.payloadHash,
          approvedBy: body.approvedBy,
          tenantId: body.tenantId,
        });
        return send(response, 200, result);
      }
      const videoApprovalMatch = url.pathname.match(
        /^\/v1\/actions\/([^/]+)\/approve-and-render$/,
      );
      if (request.method === "POST" && videoApprovalMatch) {
        const body = await readJson(request);
        const result = await approvalCoordinator.approveAndExecuteVideo({
          actionId: decodeURIComponent(videoApprovalMatch[1]),
          payloadHash: body.payloadHash,
          approvedBy: body.approvedBy,
          tenantId: body.tenantId,
        });
        return send(response, 200, result);
      }
      const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/);
      if (request.method === "GET" && orderMatch) {
        const result = await ops.readOrderStatus(
          decodeURIComponent(orderMatch[1]),
          url.searchParams.get("siteOrigin"),
        );
        return send(response, 200, result);
      }
      throw new NotFoundError("Route not found");
    } catch (error) {
      sendError(response, error);
    }
  });
}

function start() {
  const dependencies = loadRuntimeDependencies();
  const server = createRuntimeServer({
    ...dependencies,
    tier1CapabilityHandle: required("TIER1_RUNTIME_CAPABILITY_HANDLE"),
  });
  const host = process.env.RUNTIME_HOST ?? "::";
  const port = Number(process.env.RUNTIME_PORT ?? 4200);
  server.listen(port, host, () => {
    process.stdout.write(`Orchestration Runtime listening on port ${port}\n`);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    start();
  } catch (error) {
    process.stderr.write(`Orchestration Runtime failed to start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
