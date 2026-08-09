import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminPage,
  createAdminLoginHandler,
  landingPage,
} from "../src/web/server.js";

test("public agency page depicts the signed-out login flow", () => {
  const html = landingPage();
  assert.match(html, /Gated autonomous agency/);
  assert.match(html, /href="\/login">Log in to EPYHIA/);
  assert.match(html, /class="data-orb/);
  assert.match(html, /#012624/);
  assert.match(html, /#fde9ff/);
  assert.doesNotMatch(html, /href="\/admin">Open workspace/);
});

test("public agency page gives an authenticated operator workspace and sign-out paths", () => {
  const html = landingPage({ authenticated: true });
  assert.match(html, /href="\/admin">Open workspace/);
  assert.match(html, /href="\/logout">Sign out/);
});

test("Auth0 login returns directly to the operator dashboard", async () => {
  let options;
  await createAdminLoginHandler()({}, {
    oidc: {
      login(input) {
        options = input;
      },
    },
  });
  assert.deepEqual(options, { returnTo: "/admin" });
});

test("admin page locks an existing tenant business while allowing a new brief", () => {
  const html = adminPage(
    { email: "admin@example.test" },
    {
      businessName: "Naveed's Party Rentals",
      businessSlug: "naveedspartyrentals",
      businessEmail: "rentals@example.test",
      businessPhone: "555-0100",
      businessAddress: "123 Sesame Street",
    },
  );
  assert.match(html, /permanently bound to this Auth0 identity/);
  assert.match(html, /value="Naveed&#39;s Party Rentals" readonly/);
  assert.match(html, /value="naveedspartyrentals" readonly/);
  assert.match(html, /value="rentals@example\.test" readonly/);
  assert.match(html, /value="555-0100" readonly/);
  assert.match(html, /value="123 Sesame Street" readonly/);
  assert.doesNotMatch(html, /name="originalBrief"[^>]*readonly/);
});

test("admin page compiles its browser script and reuses one onboarding key for clarifications", () => {
  const html = adminPage({ email: "admin@example.test" });
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /onboardingKey=crypto\.randomUUID\(\)/);
  assert.match(script, /webBuildKey='web-build:'\+runId/);
  assert.match(script, /web-build',\{\},webBuildKey/);
  assert.match(script, /replay\.persisted\.replayed===true/);
  assert.match(script, /paidOrderCount>0/);
  assert.match(script, /duplicateOrderGroups===0/);
  assert.match(html, /Re-run same build and verify/);
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
  assert.match(html, /Agency home/);
  assert.match(html, /#012624/);
  assert.match(html, /Authenticated operator/);
  assert.doesNotMatch(html, /—|–/);
  assert.match(html, /admin@example\.test/);
});

test("admin page escapes authenticated profile text", () => {
  const html = adminPage({ email: "<script>alert(1)</script>" });
  assert.doesNotMatch(html, /Signed in as <script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
