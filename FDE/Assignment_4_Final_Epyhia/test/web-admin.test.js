import assert from "node:assert/strict";
import { test } from "node:test";
import { adminPage } from "../src/web/server.js";

test("admin page compiles its browser script and reuses one onboarding key for clarifications", () => {
  const html = adminPage({ email: "admin@example.test" });
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /onboardingKey=crypto\.randomUUID\(\)/);
  assert.match(script, /Continue the same run/);
  assert.match(script, /clarificationAnswers:clarificationHistory/);
  assert.match(script, /Question:.*Answer:/s);
  assert.match(script, /refreshTaskStatus/);
  assert.match(script, /setInterval\(refreshTaskStatus,2000\)/);
  assert.match(html, /id="task-dashboard"/);
  assert.match(script, /showMarketingPreview/);
  assert.match(script, /Exact payload hash/);
  assert.match(script, /failureMessage/);
  assert.match(html, /id="marketing-preview"/);
  assert.doesNotMatch(html, /—|–/);
  assert.match(html, /admin@example\.test/);
});

test("admin page escapes authenticated profile text", () => {
  const html = adminPage({ email: "<script>alert(1)</script>" });
  assert.doesNotMatch(html, /Signed in as <script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
