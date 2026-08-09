import { fileURLToPath } from "node:url";

function required(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`Missing Auth0 evaluation configuration ${name}`);
  return value;
}

function redirectLocation(response, label) {
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status} instead of a redirect`);
  }
  const location = response.headers.get("location");
  if (!location) throw new Error(`${label} redirect omitted Location`);
  return location;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_entity, code) =>
      String.fromCodePoint(
        code[0].toLowerCase() === "x"
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10),
      ),
    );
}

async function callbackTarget(response, issuer) {
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return new URL(redirectLocation(response, "Auth0 callback allow-list probe"), issuer);
  }
  if (response.status !== 200) {
    throw new Error(
      `Auth0 callback allow-list probe returned HTTP ${response.status} instead of a redirect or form post`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error("Auth0 callback allow-list probe returned a non-HTML form post");
  }
  const html = await response.text();
  const action = html.match(/<form\b[^>]*\baction\s*=\s*(["'])(.*?)\1/is)?.[2];
  if (!action) {
    throw new Error("Auth0 callback allow-list probe omitted its form action");
  }
  return new URL(decodeHtmlAttribute(action), issuer);
}

export async function verifyAuth0Evidence({
  agencyUrl,
  issuerBaseUrl,
  clientId,
  fetchImpl = fetch,
}) {
  const agency = new URL(agencyUrl);
  const issuer = new URL(issuerBaseUrl);
  if (agency.protocol !== "https:" || issuer.protocol !== "https:") {
    throw new Error("Agency and Auth0 issuer must use HTTPS");
  }
  const adminUrl = new URL("/admin", agency);
  const adminResponse = await fetchImpl(adminUrl, { redirect: "manual" });
  let authorizationUrl = new URL(
    redirectLocation(adminResponse, "Unauthenticated /admin"),
    agency,
  );
  if (authorizationUrl.origin === agency.origin) {
    if (authorizationUrl.pathname !== "/login") {
      throw new Error("Unauthenticated /admin did not redirect to the login route");
    }
    const loginResponse = await fetchImpl(authorizationUrl, { redirect: "manual" });
    authorizationUrl = new URL(
      redirectLocation(loginResponse, "Auth0 /login"),
      agency,
    );
  }
  if (
    authorizationUrl.origin !== issuer.origin ||
    authorizationUrl.pathname !== "/authorize"
  ) {
    throw new Error("Login did not redirect to the configured Auth0 authorization endpoint");
  }
  const expectedCallback = new URL("/callback", agency).toString();
  const scopes = new Set(
    (authorizationUrl.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean),
  );
  const responseType = authorizationUrl.searchParams.get("response_type") ?? "";
  const invalidFields = [];
  if (authorizationUrl.searchParams.get("client_id") !== clientId) {
    invalidFields.push("client_id");
  }
  if (authorizationUrl.searchParams.get("redirect_uri") !== expectedCallback) {
    invalidFields.push("redirect_uri");
  }
  if (!["code", "id_token", "code id_token"].includes(responseType)) {
    invalidFields.push("response_type");
  }
  if (responseType.includes("id_token") && !authorizationUrl.searchParams.get("nonce")) {
    invalidFields.push("nonce");
  }
  if (!scopes.has("openid")) invalidFields.push("scope");
  if (!authorizationUrl.searchParams.get("state")) invalidFields.push("state");
  if (invalidFields.length > 0) {
    throw new Error(
      `Auth0 authorization redirect has incorrect fields: ${invalidFields.join(", ")}`,
    );
  }
  const probeUrl = new URL(authorizationUrl);
  probeUrl.searchParams.set("prompt", "none");
  const issuerResponse = await fetchImpl(probeUrl, { redirect: "manual" });
  const callbackUrl = await callbackTarget(issuerResponse, issuer);
  const expectedCallbackUrl = new URL(expectedCallback);
  if (
    callbackUrl.origin !== expectedCallbackUrl.origin ||
    callbackUrl.pathname !== expectedCallbackUrl.pathname
  ) {
    throw new Error("Auth0 rejected or redirected away from the exact agency callback");
  }
  return {
    verified: true,
    adminStatus: adminResponse.status,
    issuerStatus: issuerResponse.status,
    authorizationOrigin: authorizationUrl.origin,
    callback: expectedCallback,
  };
}

async function main() {
  let inputText = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) inputText += chunk;
  const input = JSON.parse(inputText);
  const result = await verifyAuth0Evidence({
    agencyUrl: input.agencyUrl,
    issuerBaseUrl: required("ISSUER_BASE_URL"),
    clientId: required("CLIENT_ID"),
  });
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Auth0 evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
