import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAuth0Evidence } from "../eval/auth0-evidence.js";

const AGENCY = "https://agency.example.test";
const ISSUER = "https://tenant.auth0.example";
const CLIENT_ID = "client_epyhia_test";

function authorizationUrl(overrides = {}) {
  const url = new URL("/authorize", ISSUER);
  const values = {
    client_id: CLIENT_ID,
    redirect_uri: `${AGENCY}/callback`,
    response_type: "id_token",
    scope: "openid profile email",
    state: "signed-state",
    nonce: "signed-nonce",
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) url.searchParams.set(name, value);
  return url.toString();
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location } });
}

test("live Auth0 evidence follows the protected admin route to exact OIDC fields", async () => {
  const requests = [];
  const result = await verifyAuth0Evidence({
    agencyUrl: AGENCY,
    issuerBaseUrl: ISSUER,
    clientId: CLIENT_ID,
    async fetchImpl(input, options) {
      requests.push({ url: String(input), options });
      if (requests.length === 1) return redirect("/login");
      if (requests.length === 2) return redirect(authorizationUrl());
      return redirect(`${AGENCY}/callback?error=login_required&state=signed-state`);
    },
  });

  assert.equal(result.verified, true);
  assert.equal(result.callback, `${AGENCY}/callback`);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.options.redirect === "manual"));
  assert.equal(new URL(requests[2].url).searchParams.get("prompt"), "none");
});

test("live Auth0 evidence rejects a publicly readable admin page", async () => {
  await assert.rejects(
    verifyAuth0Evidence({
      agencyUrl: AGENCY,
      issuerBaseUrl: ISSUER,
      clientId: CLIENT_ID,
      async fetchImpl() {
        return new Response("public admin", { status: 200 });
      },
    }),
    /instead of a redirect/,
  );
});

test("live Auth0 evidence rejects the wrong callback", async () => {
  await assert.rejects(
    verifyAuth0Evidence({
      agencyUrl: AGENCY,
      issuerBaseUrl: ISSUER,
      clientId: CLIENT_ID,
      async fetchImpl(input) {
        return String(input).endsWith("/admin")
          ? redirect("/login")
          : redirect(authorizationUrl({ redirect_uri: "https://wrong.example/callback" }));
      },
    }),
    /incorrect fields: redirect_uri/,
  );
});

test("live Auth0 evidence rejects a different authorization issuer", async () => {
  await assert.rejects(
    verifyAuth0Evidence({
      agencyUrl: AGENCY,
      issuerBaseUrl: ISSUER,
      clientId: CLIENT_ID,
      async fetchImpl(input) {
        return String(input).endsWith("/admin")
          ? redirect("/login")
          : redirect(authorizationUrl().replace(ISSUER, "https://wrong.auth.example"));
      },
    }),
    /configured Auth0 authorization endpoint/,
  );
});

test("live Auth0 evidence rejects an ID-token flow without a nonce", async () => {
  await assert.rejects(
    verifyAuth0Evidence({
      agencyUrl: AGENCY,
      issuerBaseUrl: ISSUER,
      clientId: CLIENT_ID,
      async fetchImpl(input) {
        return String(input).endsWith("/admin")
          ? redirect("/login")
          : redirect(authorizationUrl({ nonce: "" }));
      },
    }),
    /incorrect fields: nonce/,
  );
});

test("live Auth0 evidence rejects a callback disallowed by Auth0 itself", async () => {
  let requestCount = 0;
  await assert.rejects(
    verifyAuth0Evidence({
      agencyUrl: AGENCY,
      issuerBaseUrl: ISSUER,
      clientId: CLIENT_ID,
      async fetchImpl() {
        requestCount += 1;
        if (requestCount === 1) return redirect("/login");
        if (requestCount === 2) return redirect(authorizationUrl());
        return new Response("Callback URL mismatch", { status: 403 });
      },
    }),
    /allow-list probe returned HTTP 403/,
  );
});
