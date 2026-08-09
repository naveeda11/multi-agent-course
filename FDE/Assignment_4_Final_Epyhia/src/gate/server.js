import { createServer } from "node:http";
import { ActionGate } from "./action-gate.js";
import { loadGateDependencies } from "./config.js";
import { bearer, readJson, readRaw, send, sendError } from "./http.js";
import { NotFoundError } from "../shared/errors.js";

export function createGateServer({ gate }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://action-gate.internal");
      if (request.method === "GET" && url.pathname === "/health") {
        return send(response, 200, { status: "ok", tier: 3 });
      }

      if (request.method === "POST" && url.pathname === "/v1/actions/deploy") {
        const body = await readJson(request);
        const result = await gate.requestDeploy({
          capabilityHandle: bearer(request),
          tenantId: body.tenantId,
          runId: body.runId,
          agentName: body.agentName,
          idempotencyKey: request.headers["idempotency-key"],
          mode: body.mode,
          payload: body.payload,
        });
        return send(response, result.replayed ? 200 : 202, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/onboarding/run-shell") {
        const body = await readJson(request);
        const result = await gate.createRunShell({
          capabilityHandle: bearer(request),
          tenant: body.tenant,
          originalBrief: body.originalBrief,
          approvedBudgetMicrodollars: body.approvedBudgetMicrodollars,
          approvedBy: body.approvedBy,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/onboarding/finalize") {
        const body = await readJson(request);
        const result = await gate.finalizeRun({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          tenantId: body.tenantId,
          runId: body.runId,
          completedBrief: body.completedBrief,
          brandDocument: body.brandDocument,
          taskPlan: body.taskPlan,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/model-call") {
        const body = await readJson(request);
        const result = await gate.modelCall({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          tenantId: body.tenantId,
          runId: body.runId,
          taskId: body.taskId,
          instructions: body.instructions,
          input: body.input,
          maxOutputTokens: body.maxOutputTokens,
          responseSchema: body.responseSchema,
          purpose: body.purpose,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/checkout-session") {
        const body = await readJson(request);
        const result = await gate.createCheckoutSession({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          siteOrigin: body.siteOrigin,
          customer: body.customer,
          startDate: body.startDate,
          endDate: body.endDate,
          items: body.items,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/catalog") {
        const body = await readJson(request);
        const result = await gate.persistCatalog({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          tenantId: body.tenantId,
          runId: body.runId,
          items: body.items,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      const contextMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/context$/);
      if (request.method === "GET" && contextMatch) {
        const result = await gate.readRunContext({
          capabilityHandle: bearer(request),
          agentName: request.headers["x-agent-name"],
          tenantId: url.searchParams.get("tenantId"),
          runId: decodeURIComponent(contextMatch[1]),
        });
        return send(response, 200, result);
      }

      const runAuditMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/audit$/);
      if (request.method === "GET" && runAuditMatch) {
        const result = await gate.readRunAudit({
          capabilityHandle: bearer(request),
          tenantId: url.searchParams.get("tenantId"),
          runId: decodeURIComponent(runAuditMatch[1]),
        });
        return send(response, 200, result);
      }

      const tenantProfileMatch = url.pathname.match(
        /^\/v1\/tenants\/([^/]+)\/profile$/,
      );
      if (request.method === "GET" && tenantProfileMatch) {
        const profile = await gate.readTenantProfile({
          capabilityHandle: bearer(request),
          tenantId: decodeURIComponent(tenantProfileMatch[1]),
        });
        return send(response, 200, { profile });
      }
      if (request.method === "DELETE" && tenantProfileMatch) {
        const body = await readJson(request);
        const result = await gate.eraseTenant({
          capabilityHandle: bearer(request),
          tenantId: decodeURIComponent(tenantProfileMatch[1]),
          auth0UserId: body.auth0UserId,
          confirmation: body.confirmation,
        });
        return send(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/marketing-pack") {
        const body = await readJson(request);
        const result = await gate.persistMarketingPack({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          tenantId: body.tenantId,
          runId: body.runId,
          pack: body.pack,
          review: body.review,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/site-artifact") {
        const body = await readJson(request);
        const result = await gate.persistSiteArtifact({
          capabilityHandle: bearer(request),
          agentName: body.agentName,
          tenantId: body.tenantId,
          runId: body.runId,
          html: body.html,
          publicApiBaseUrl: body.publicApiBaseUrl,
          review: body.review,
          revisionNumber: body.revisionNumber,
          idempotencyKey: request.headers["idempotency-key"],
        });
        return send(response, result.replayed ? 200 : 201, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/stripe/webhook") {
        const result = await gate.processStripeWebhook({
          capabilityHandle: bearer(request),
          agentName: request.headers["x-agent-name"],
          rawBody: await readRaw(request),
          signature: request.headers["stripe-signature"],
        });
        return send(response, 200, result);
      }

      const orderMatch = url.pathname.match(/^\/v1\/orders\/([^/]+)$/);
      if (request.method === "GET" && orderMatch) {
        const result = await gate.readOrderStatus({
          capabilityHandle: bearer(request),
          agentName: request.headers["x-agent-name"],
          reservationId: decodeURIComponent(orderMatch[1]),
          siteOrigin: url.searchParams.get("siteOrigin"),
        });
        return send(response, 200, result);
      }

      const approvalMatch = url.pathname.match(/^\/v1\/actions\/([^/]+)\/approve$/);
      if (request.method === "POST" && approvalMatch) {
        const body = await readJson(request);
        const action = await gate.approve({
          capabilityHandle: bearer(request),
          actionId: approvalMatch[1],
          payloadHash: body.payloadHash,
          approvedBy: body.approvedBy,
          tenantId: body.tenantId,
        });
        return send(response, 200, { action });
      }

      const executionMatch = url.pathname.match(/^\/v1\/actions\/([^/]+)\/execute$/);
      if (request.method === "POST" && executionMatch) {
        const body = await readJson(request);
        const result = await gate.executeDeploy({
          capabilityHandle: bearer(request),
          actionId: executionMatch[1],
          agentName: body.agentName,
        });
        return send(response, 200, result);
      }
      const videoExecutionMatch = url.pathname.match(
        /^\/v1\/actions\/([^/]+)\/execute-video$/,
      );
      if (request.method === "POST" && videoExecutionMatch) {
        const body = await readJson(request);
        const result = await gate.executeVideoRender({
          capabilityHandle: bearer(request),
          actionId: videoExecutionMatch[1],
          agentName: body.agentName,
        });
        return send(response, 200, result);
      }

      const actionMatch = url.pathname.match(/^\/v1\/actions\/([^/]+)$/);
      if (request.method === "GET" && actionMatch) {
        return send(response, 200, {
          action: await gate.readAudit({
            capabilityHandle: bearer(request),
            actionId: actionMatch[1],
            subject: request.headers["x-capability-subject"],
          }),
        });
      }

      throw new NotFoundError("Route not found");
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function start() {
  const dependencies = loadGateDependencies();
  const gate = new ActionGate(dependencies);
  if (process.env.ACTION_GATE_AUTO_MIGRATE === "true") {
    if (!dependencies.neonRepository) {
      throw new Error("ACTION_GATE_AUTO_MIGRATE requires DATABASE_URL");
    }
    await dependencies.neonRepository.migrate();
  }
  const server = createGateServer({ gate });
  const host = process.env.ACTION_GATE_HOST ?? "127.0.0.1";
  const port = Number(process.env.ACTION_GATE_PORT ?? 4100);
  server.listen(port, host, () => {
    process.stdout.write(`Action Gate listening on http://${host}:${port}\n`);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  start().catch((error) => {
    process.stderr.write(`Action Gate failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
