import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Fly deployment preserves three tiers with one demo Machine each", async () => {
  const [script, gate, runtime, web, dockerfile] = await Promise.all([
    readFile(new URL("../scripts/deploy-fly.js", import.meta.url), "utf8"),
    readFile(new URL("../deploy/fly.gate.toml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/fly.runtime.toml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/fly.web.toml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);

  assert.ok(script.indexOf("${prefix}-gate") < script.indexOf("${prefix}-runtime"));
  assert.ok(script.indexOf("${prefix}-runtime") < script.indexOf("${prefix}-web"));
  assert.match(script, /"--ha=false"/);
  assert.match(script, /Tier 1 health verification failed/);

  assert.doesNotMatch(gate, /\[http_service\]/);
  assert.doesNotMatch(runtime, /\[http_service\]/);
  assert.match(web, /\[http_service\]/);
  assert.match(web, /force_https = true/);
  assert.match(gate, /dockerfile = "\.\.\/Dockerfile"/);
  assert.match(runtime, /dockerfile = "\.\.\/Dockerfile"/);
  assert.match(web, /dockerfile = "\.\.\/Dockerfile"/);
  assert.match(gate, /ACTION_GATE_HOST = "::"/);
  assert.match(runtime, /RUNTIME_HOST = "::"/);
  assert.match(dockerfile, /^USER node$/m);
});
