import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/shared/canonical.js";
import { CloudflareDeploymentProvider } from "../src/gate/providers/cloudflare-deployment.js";
import { LocalDeploymentProvider } from "../src/gate/providers/local-deployment.js";
import { cloudflareProjectName } from "../src/gate/neon-repository.js";

const html = "<!doctype html><title>Exact approved payload</title>";

test("Cloudflare project names remain stable and unique within the Gate limit", () => {
  assert.equal(cloudflareProjectName("brightday-rentals"), "epyhia-brightday-rentals");
  const first = cloudflareProjectName(`long-${"a".repeat(59)}`);
  const second = cloudflareProjectName(`long-${"a".repeat(58)}b`);
  assert.equal(first.length, 58);
  assert.equal(second.length, 58);
  assert.notEqual(first, second);
  assert.match(first, /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/);
});

test("local deployment verification requires the exact approved index hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "epyhia-local-provider-"));
  try {
    const provider = new LocalDeploymentProvider({ root });
    const deployed = await provider.deploy({
      projectName: "verified-project",
      files: { "index.html": html },
    });
    assert.equal(
      await provider.verify(deployed.liveUrl, {
        projectName: "verified-project",
        expectedContentHash: sha256(html),
      }),
      true,
    );
    assert.equal(
      await provider.verify(deployed.liveUrl, {
        projectName: "verified-project",
        expectedContentHash: sha256("older content"),
      }),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare verification hashes the content served at the live URL", async () => {
  const provider = new CloudflareDeploymentProvider({
    accountId: "account-test",
    apiToken: "token-test",
    wranglerPath: "/usr/bin/true",
    verificationAttempts: 1,
    verificationIntervalMs: 0,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith(".pages.dev")) {
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const deployed = await provider.deploy({
    projectName: "verified-project",
    actionId: "action-test",
    files: { "index.html": html },
  });
  assert.equal(
    await provider.verify(deployed.liveUrl, { expectedContentHash: sha256(html) }),
    true,
  );
  assert.equal(
    await provider.verify(deployed.liveUrl, { expectedContentHash: sha256("older content") }),
    false,
  );
});

test("Cloudflare deletion verifies both the project and live URL are gone", async () => {
  const calls = [];
  const provider = new CloudflareDeploymentProvider({
    accountId: "account-test",
    apiToken: "token-test",
    verificationAttempts: 1,
    verificationIntervalMs: 0,
    fetchImpl: async (input, options = {}) => {
      calls.push({ input: String(input), method: options.method ?? "GET" });
      if (options.method === "DELETE") return new Response("{}", { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  const result = await provider.deleteProject({
    projectName: "verified-project",
    liveUrl: "https://verified-project.pages.dev",
  });
  assert.equal(result.deleted, true);
  assert.deepEqual(calls.map((call) => call.method), ["DELETE", "GET", "GET"]);
});
