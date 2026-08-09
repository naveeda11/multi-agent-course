import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createGateServer } from "../src/gate/server.js";
import { ActionGateClient } from "../src/runtime/gate-client.js";
import { Ops } from "../src/runtime/ops.js";
import { createRuntimeServer } from "../src/runtime/server.js";
import { RuntimeClient } from "../src/web/runtime-client.js";
import { createStripeWebhookHandler } from "../src/web/server.js";

const TIER1_RUNTIME_HANDLE = "Tier1RuntimeCapabilityHandleForTests0001";

function inMemoryFetch(server) {
  const listener = server.listeners("request")[0];
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const requestBody = options.body === undefined
      ? []
      : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)];
    const request = Readable.from(requestBody);
    request.method = options.method ?? "GET";
    request.url = `${url.pathname}${url.search}`;
    request.headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    return new Promise((resolve, reject) => {
      let status = 200;
      let headers = {};
      const chunks = [];
      const response = {
        writeHead(nextStatus, nextHeaders) {
          status = nextStatus;
          headers = nextHeaders;
        },
        write(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
        },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk));
          resolve(new Response(Buffer.concat(chunks), { status, headers }));
        },
      };
      Promise.resolve(listener(request, response)).catch(reject);
    });
  };
}

test("raw Stripe webhook bytes and signature cross Tier 1 and Tier 2 unchanged", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async processStripeWebhook(input) {
        received.push(input);
        return { eventId: "evt_test", persisted: true };
      },
    },
  });
  const ops = new Ops({
    gateClient: new ActionGateClient({
      baseUrl: "http://action-gate.internal",
      capabilityHandle: "http-tier-ops-capability",
      agentName: "ops",
      fetchImpl: inMemoryFetch(gateServer),
    }),
  });
  const runtimeServer = createRuntimeServer({
    ops,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });
  const handler = createStripeWebhookHandler(runtimeClient);
  const raw = '{"id":"evt_test","data":{"object":{"value":"a  b"}}}\n';
  const signature = "t=1700000000,v1=exact-signature";
  let responseBody;
  let forwardedError;
  await handler(
    {
      body: Buffer.from(raw),
      get(name) {
        return name.toLowerCase() === "stripe-signature" ? signature : undefined;
      },
    },
    { json(body) { responseBody = body; } },
    (error) => { forwardedError = error; },
  );
  assert.equal(forwardedError, undefined);
  assert.deepEqual(responseBody, { eventId: "evt_test", persisted: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].rawBody.toString("utf8"), raw);
  assert.equal(received[0].signature, signature);
  assert.equal(received[0].agentName, "ops");
  assert.equal(received[0].capabilityHandle, "http-tier-ops-capability");
});

test("authenticated run status crosses Tier 2 through an admin read capability", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async readRunContext(input) {
        received.push(input);
        return {
          runId: "run_status_test",
          runStatus: "EXECUTING",
          tasks: [
            { id: "task_catalog", taskType: "CATALOG_PERSIST", status: "COMPLETE" },
            { id: "task_web", taskType: "WEB_BUILD", status: "READY_FOR_DEPLOY" },
          ],
        };
      },
    },
  });
  const runStatusReader = new ActionGateClient({
    baseUrl: "http://action-gate.internal",
    capabilityHandle: "http-tier-admin-capability",
    agentName: "admin",
    fetchImpl: inMemoryFetch(gateServer),
  });
  const runtimeServer = createRuntimeServer({
    runStatusReader,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });

  const result = await runtimeClient.readRunStatus({
    tenantId: "tenant_status_test",
    runId: "run_status_test",
  });

  assert.equal(result.status, "EXECUTING");
  assert.equal(result.tasks[1].status, "READY_FOR_DEPLOY");
  assert.equal(received.length, 1);
  assert.equal(received[0].tenantId, "tenant_status_test");
  assert.equal(received[0].runId, "run_status_test");
  assert.equal(received[0].agentName, "admin");
  assert.equal(received[0].capabilityHandle, "http-tier-admin-capability");
});

test("persisted deliverables cross the admin read path without model replay", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async readRunDeliverables(input) {
        received.push(input);
        return {
          runId: "run_restore_test",
          website: null,
          marketing: {
            pack: { landingCopy: "Stored copy" },
            persisted: { packHash: "b".repeat(64) },
          },
        };
      },
    },
  });
  const runDeliverableReader = new ActionGateClient({
    baseUrl: "http://action-gate.internal",
    capabilityHandle: "http-tier-admin-capability",
    agentName: "admin",
    fetchImpl: inMemoryFetch(gateServer),
  });
  const runtimeServer = createRuntimeServer({
    runDeliverableReader,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });

  const result = await runtimeClient.readRunDeliverables({
    tenantId: "tenant_restore_test",
    runId: "run_restore_test",
  });

  assert.equal(result.marketing.pack.landingCopy, "Stored copy");
  assert.equal(result.website, null);
  assert.equal(received[0].tenantId, "tenant_restore_test");
  assert.equal(received[0].capabilityHandle, "http-tier-admin-capability");
});

test("brand approval returns before independent generation requests", async () => {
  const received = [];
  const runtimeServer = createRuntimeServer({
    brandWorkflow: {
      async approveBrandDocument(input) {
        received.push(input);
        return { approvalStatus: "APPROVED" };
      },
    },
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });

  const result = await runtimeClient.approveBrandDocument({
    tenantId: "tenant_brand_test",
    runId: "run_brand_test",
    brandDocumentId: "brand_test",
    contentHash: "a".repeat(64),
    approvedBy: "auth0|admin",
  });

  assert.equal(result.approvalStatus, "APPROVED");
  assert.deepEqual(received, [{
    tenantId: "tenant_brand_test",
    runId: "run_brand_test",
    brandDocumentId: "brand_test",
    contentHash: "a".repeat(64),
    approvedBy: "auth0|admin",
  }]);
});

test("tenant-bound audit and cost data crosses only the admin read path", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async readRunAudit(input) {
        received.push(input);
        return {
          runId: "run_audit_test",
          costs: {
            modelCostMicrodollars: 12_000,
            providerCostMicrodollars: 0,
            totalCostMicrodollars: 12_000,
          },
          idempotencyEvidence: {
            deploymentCount: 1,
            siteArtifactCount: 1,
            paidOrderCount: 1,
            duplicateOrderGroups: 0,
            projectName: "epyhia-demo",
            liveUrl: "https://epyhia-demo.pages.dev",
            deploymentActionId: "action_deploy",
            orderIds: ["order_demo"],
          },
          modelCalls: [
            { agentName: "strategist", modelTier: "sol", costMicrodollars: 12_000 },
          ],
          actions: [
            { actionType: "create-run-shell", status: "EXECUTED" },
          ],
        };
      },
    },
  });
  const runAuditReader = new ActionGateClient({
    baseUrl: "http://action-gate.internal",
    capabilityHandle: "http-tier-admin-capability",
    agentName: "admin",
    fetchImpl: inMemoryFetch(gateServer),
  });
  const runtimeServer = createRuntimeServer({
    runAuditReader,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });
  const result = await runtimeClient.readRunAudit({
    tenantId: "tenant_audit_test",
    runId: "run_audit_test",
  });
  assert.equal(result.costs.totalCostMicrodollars, 12_000);
  assert.equal(result.modelCalls[0].modelTier, "sol");
  assert.equal(result.idempotencyEvidence.deploymentCount, 1);
  assert.equal(result.idempotencyEvidence.duplicateOrderGroups, 0);
  assert.equal(received[0].tenantId, "tenant_audit_test");
  assert.equal(received[0].runId, "run_audit_test");
  assert.equal(received[0].capabilityHandle, "http-tier-admin-capability");
});

test("an existing tenant profile crosses the authenticated admin read path", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async readTenantProfile(input) {
        received.push(input);
        return {
          tenantId: "tenant_profile_test",
          businessName: "Existing Rentals",
          businessSlug: "existing-rentals",
        };
      },
    },
  });
  const tenantProfileReader = new ActionGateClient({
    baseUrl: "http://action-gate.internal",
    capabilityHandle: "http-tier-admin-capability",
    agentName: "admin",
    fetchImpl: inMemoryFetch(gateServer),
  });
  const runtimeServer = createRuntimeServer({
    tenantProfileReader,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });

  const result = await runtimeClient.readTenantProfile({
    tenantId: "tenant_profile_test",
  });

  assert.equal(result.profile.businessName, "Existing Rentals");
  assert.equal(received[0].tenantId, "tenant_profile_test");
  assert.equal(received[0].capabilityHandle, "http-tier-admin-capability");
});

test("tenant erasure crosses Tier 2 and reaches only the admin Gate capability", async () => {
  const received = [];
  const gateServer = createGateServer({
    gate: {
      async eraseTenant(input) {
        received.push(input);
        return { deleted: true };
      },
    },
  });
  const tenantEraser = new ActionGateClient({
    baseUrl: "http://action-gate.internal",
    capabilityHandle: "http-tier-admin-capability",
    agentName: "admin",
    fetchImpl: inMemoryFetch(gateServer),
  });
  const runtimeServer = createRuntimeServer({
    tenantEraser,
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    fetchImpl: inMemoryFetch(runtimeServer),
  });
  const result = await runtimeClient.eraseTenant({
    tenantId: "tenant_delete_test",
    auth0UserId: "auth0|delete-test",
    confirmation: "DELETE",
  });
  assert.equal(result.deleted, true);
  assert.equal(received[0].tenantId, "tenant_delete_test");
  assert.equal(received[0].auth0UserId, "auth0|delete-test");
  assert.equal(received[0].confirmation, "DELETE");
  assert.equal(received[0].capabilityHandle, "http-tier-admin-capability");
});

test("Tier 2 rejects requests without the exact Tier 1 capability", async () => {
  let called = false;
  const runtimeServer = createRuntimeServer({
    ops: {
      async readOrderStatus() {
        called = true;
        return { status: "PAID" };
      },
    },
    tier1CapabilityHandle: TIER1_RUNTIME_HANDLE,
  });
  const wrongClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: "WrongTier1RuntimeCapabilityHandle000001",
    fetchImpl: inMemoryFetch(runtimeServer),
  });

  await assert.rejects(
    wrongClient.readOrderStatus(
      "reservation_capability_test",
      "https://business.example.test",
    ),
    (error) => error.code === "UNAUTHENTICATED" && error.status === 401,
  );
  assert.equal(called, false);

  const health = await inMemoryFetch(runtimeServer)("http://runtime.internal/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", tier: 2 });
});

test("every Tier 1 Runtime client method sends the capability", async () => {
  const requests = [];
  const runtimeClient = new RuntimeClient({
    baseUrl: "http://runtime.internal",
    capabilityHandle: TIER1_RUNTIME_HANDLE,
    async fetchImpl(input, options = {}) {
      requests.push({ input, options });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await runtimeClient.onboard({}, "onboard-key");
  await runtimeClient.createCheckoutSession({}, "checkout-key");
  await runtimeClient.forwardStripeWebhook(Buffer.from("{}"), "stripe-signature");
  await runtimeClient.readOrderStatus("reservation", "https://business.example.test");
  await runtimeClient.readRunStatus({ tenantId: "tenant", runId: "run" });
  await runtimeClient.readRunDeliverables({ tenantId: "tenant", runId: "run" });
  await runtimeClient.readRunAudit({ tenantId: "tenant", runId: "run" });
  await runtimeClient.readTenantProfile({ tenantId: "tenant" });
  await runtimeClient.eraseTenant({
    tenantId: "tenant",
    auth0UserId: "auth0|tenant",
    confirmation: "DELETE",
  });
  await runtimeClient.createMarketingPack(
    { tenantId: "tenant", runId: "run" },
    "marketing-key",
  );
  await runtimeClient.buildWebsite(
    { tenantId: "tenant", runId: "run" },
    "web-key",
  );
  await runtimeClient.approveBrandAndGenerate({
    tenantId: "tenant",
    runId: "run",
    brandDocumentId: "brand",
    contentHash: "c".repeat(64),
    approvedBy: "admin",
  });
  await runtimeClient.approveBrandDocument({
    tenantId: "tenant",
    runId: "run",
    brandDocumentId: "brand",
    contentHash: "c".repeat(64),
    approvedBy: "admin",
  });
  await runtimeClient.reviseArtifact({
    tenantId: "tenant",
    sourceRunId: "run",
    artifactType: "WEB_BUILD",
    feedback: "Make pricing easier to scan",
    approvedBudgetMicrodollars: 500_000,
    approvedBy: "admin",
  }, "revision-key");
  await runtimeClient.approveMarketingPack({
    tenantId: "tenant",
    runId: "run",
    packHash: "d".repeat(64),
    approvedBy: "admin",
  });
  await runtimeClient.approveAndExecuteDeployment({
    actionId: "action",
    payloadHash: "a".repeat(64),
    approvedBy: "admin",
    tenantId: "tenant",
  });
  await runtimeClient.approveAndExecuteVideo({
    actionId: "video",
    payloadHash: "b".repeat(64),
    approvedBy: "admin",
    tenantId: "tenant",
  });

  assert.equal(requests.length, 17);
  for (const request of requests) {
    assert.equal(
      request.options.headers.authorization,
      `Bearer ${TIER1_RUNTIME_HANDLE}`,
    );
  }
});

test("Tier 1 and Tier 2 refuse startup without an explicit valid handle", () => {
  assert.throws(
    () => new RuntimeClient({ baseUrl: "http://runtime.internal" }),
    /TIER1_RUNTIME_CAPABILITY_HANDLE/,
  );
  assert.throws(
    () => createRuntimeServer({ tier1CapabilityHandle: "short" }),
    /TIER1_RUNTIME_CAPABILITY_HANDLE/,
  );
});
