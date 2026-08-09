import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionGate } from "../src/gate/action-gate.js";
import { ACTIONS, CapabilityRegistry } from "../src/gate/capabilities.js";
import { ErasureService } from "../src/gate/erasure-service.js";
import { Auth0ManagementProvider } from "../src/gate/providers/auth0-management.js";
import { StripeSandboxProvider } from "../src/gate/providers/stripe-sandbox.js";
import { AuthenticationError, ProviderError, ValidationError } from "../src/shared/errors.js";

test("tenant erasure removes every provider footprint before deleting Neon and Auth0", async () => {
  const calls = [];
  const service = new ErasureService({
    repository: {
      async readErasureManifest() {
        calls.push("manifest");
        return {
          tenantId: "tenant_demo",
          projectName: "epyhia-demo",
          liveUrl: "https://epyhia-demo.pages.dev",
          r2Prefix: "epyhia-demo/tenant_demo/",
          stripeCheckoutSessionIds: ["cs_test_demo"],
        };
      },
      async deleteTenantData() {
        calls.push("neon");
        return { deleted: true };
      },
    },
    deploymentProvider: {
      async deleteProject() {
        calls.push("cloudflare");
        return { deleted: true };
      },
    },
    storage: {
      async deletePrefix() {
        calls.push("r2");
        return { deletedObjects: 2 };
      },
    },
    stripeProvider: {
      async eraseCheckoutSessions() {
        calls.push("stripe");
        return { sessions: [{ sessionId: "cs_test_demo" }] };
      },
    },
    auth0Provider: {
      async deleteUser() {
        calls.push("auth0");
        return { deleted: true };
      },
    },
  });

  const result = await service.erase({
    tenantId: "tenant_demo",
    auth0UserId: "google-oauth2|demo",
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(calls, ["manifest", "cloudflare", "r2", "stripe", "neon", "auth0"]);
});

test("tenant erasure keeps Neon and Auth0 intact when undeploy verification fails", async () => {
  const calls = [];
  const service = new ErasureService({
    repository: {
      async readErasureManifest() {
        return {
          projectName: "epyhia-demo",
          liveUrl: "https://epyhia-demo.pages.dev",
          r2Prefix: "epyhia-demo/tenant_demo/",
          stripeCheckoutSessionIds: [],
        };
      },
      async deleteTenantData() {
        calls.push("neon");
      },
    },
    deploymentProvider: {
      async deleteProject() {
        throw new ProviderError("not gone");
      },
    },
    storage: { async deletePrefix() { calls.push("r2"); } },
    stripeProvider: { async eraseCheckoutSessions() { calls.push("stripe"); } },
    auth0Provider: { async deleteUser() { calls.push("auth0"); } },
  });
  await assert.rejects(
    service.erase({ tenantId: "tenant_demo", auth0UserId: "auth0|demo" }),
    ProviderError,
  );
  assert.deepEqual(calls, []);
});

test("Action Gate requires the erasure capability and explicit DELETE confirmation", async () => {
  const gate = new ActionGate({
    repository: {},
    deploymentProvider: {},
    capabilities: new CapabilityRegistry([
      { handle: "admin-erasure", subject: "admin", actions: [ACTIONS.ERASE_TENANT] },
    ]),
    erasureService: {
      async erase(input) {
        return { ...input, deleted: true };
      },
    },
  });
  const input = {
    capabilityHandle: "admin-erasure",
    tenantId: "tenant_demo",
    auth0UserId: "auth0|demo",
  };
  await assert.rejects(gate.eraseTenant({ ...input, confirmation: "yes" }), ValidationError);
  await assert.rejects(
    gate.eraseTenant({ ...input, capabilityHandle: "wrong", confirmation: "DELETE" }),
    AuthenticationError,
  );
  assert.equal((await gate.eraseTenant({ ...input, confirmation: "DELETE" })).deleted, true);
});

test("Auth0 deletion obtains a Management API token and deletes the exact user", async () => {
  const requests = [];
  const provider = new Auth0ManagementProvider({
    issuerBaseUrl: "https://tenant.example.auth0.com",
    clientId: "management-client",
    clientSecret: "management-secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "management-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    },
  });
  await provider.deleteUser("google-oauth2|demo-user");
  assert.equal(requests[1].options.method, "DELETE");
  assert.match(requests[1].url, /google-oauth2%7Cdemo-user$/);
  assert.equal(requests[1].options.headers.Authorization, "Bearer management-token");
});

test("Stripe erasure expires open sessions and removes every EPYHIA association", async () => {
  const calls = [];
  const provider = new StripeSandboxProvider({
    client: {
      checkout: {
        sessions: {
          async retrieve() {
            return {
              id: "cs_test_demo",
              livemode: false,
              status: "open",
              customer: { id: "cus_test_demo" },
              payment_intent: {
                id: "pi_test_demo",
                latest_charge: { id: "ch_test_demo" },
              },
            };
          },
          async expire(id) { calls.push(["expire", id]); },
          async update(id, body) { calls.push(["session", id, body]); },
        },
      },
      paymentIntents: {
        async update(id, body) { calls.push(["intent", id, body]); },
      },
      charges: {
        async update(id, body) { calls.push(["charge", id, body]); },
      },
      customers: {
        async del(id) { calls.push(["customer", id]); },
      },
    },
  });
  const result = await provider.eraseCheckoutSessions(["cs_test_demo"]);
  assert.equal(result.sessions[0].customerDeleted, true);
  assert.deepEqual(calls.map((call) => call[0]), [
    "expire",
    "session",
    "intent",
    "charge",
    "customer",
  ]);
});
