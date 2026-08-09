import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTierEnvironment } from "../scripts/start-tier.js";

const source = {
  NODE_ENV: "development",
  OPENAI_API_KEY: "openai-test",
  DATABASE_URL: "postgresql://test",
  STRIPE_SANDBOX_SECRET_KEY: "sk_test_example",
  CLOUDFLARE_API_TOKEN: "cloudflare-test",
  ACTION_GATE_URL: "http://gate.internal:4100",
  RUNTIME_URL: "http://runtime.internal:4200",
  TIER1_RUNTIME_CAPABILITY_HANDLE: "Tier1RuntimeCapabilityHandleForTests0001",
  WEB_BUILDER_CAPABILITY_HANDLE: "capability-test",
  ISSUER_BASE_URL: "https://auth.example.test",
  CLIENT_ID: "client-test",
  SECRET: "session-test",
  BASE_URL: "https://agency.example.test",
  UNRELATED_OPERATOR_SECRET: "never-in-a-tier",
};

test("local tier startup exposes provider credentials only to the Gate", () => {
  const gate = buildTierEnvironment("gate", source);
  const runtime = buildTierEnvironment("runtime", source);
  const web = buildTierEnvironment("web", source);

  assert.equal(gate.OPENAI_API_KEY, "openai-test");
  assert.equal(gate.DATABASE_URL, "postgresql://test");
  assert.equal(gate.STRIPE_SANDBOX_SECRET_KEY, "sk_test_example");
  assert.equal(gate.CLOUDFLARE_API_TOKEN, "cloudflare-test");
  assert.equal(runtime.ACTION_GATE_URL, "http://gate.internal:4100");
  assert.equal(runtime.WEB_BUILDER_CAPABILITY_HANDLE, "capability-test");
  assert.equal(
    runtime.TIER1_RUNTIME_CAPABILITY_HANDLE,
    "Tier1RuntimeCapabilityHandleForTests0001",
  );
  assert.equal(web.RUNTIME_URL, "http://runtime.internal:4200");
  assert.equal(
    web.TIER1_RUNTIME_CAPABILITY_HANDLE,
    "Tier1RuntimeCapabilityHandleForTests0001",
  );
  assert.equal(web.SECRET, "session-test");

  for (const environment of [runtime, web]) {
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.STRIPE_SANDBOX_SECRET_KEY, undefined);
    assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  }
  for (const environment of [gate, runtime, web]) {
    assert.equal(environment.UNRELATED_OPERATOR_SECRET, undefined);
  }
  assert.equal(gate.TIER1_RUNTIME_CAPABILITY_HANDLE, undefined);
});
