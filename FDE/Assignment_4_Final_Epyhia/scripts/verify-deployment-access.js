import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(binary, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, args, {
      cwd: root,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => resolvePromise({ ok: false, stdout: "", stderr }));
    child.on("close", (code) =>
      resolvePromise({ ok: code === 0, stdout, stderr }),
    );
  });
}

function sanitize(message) {
  let result = String(message ?? "");
  for (const key of [
    "FLY_ORG_TOKEN",
    "CLOUDFLARE_R2_TOKEN",
    "CLOUDFLARE_R2_ACCESS_KEY_ID",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  ]) {
    const value = process.env[key];
    if (value) result = result.split(value).join("[redacted]");
  }
  return result
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function auth0Check() {
  const issuer = process.env.ISSUER_BASE_URL;
  const clientId = process.env.CLIENT_ID;
  const baseUrl = process.env.BASE_URL;
  const flyAppPrefix = process.env.FLY_APP_PREFIX;
  if (!issuer || !clientId || !baseUrl || !flyAppPrefix) {
    return {
      discovery: false,
      configuredCallback: false,
      flyCallback: false,
      configuredLogout: false,
      flyLogout: false,
    };
  }
  try {
    const response = await fetch(
      new URL(".well-known/openid-configuration", `${issuer.replace(/\/$/, "")}/`),
    );
    if (!response.ok) {
      return {
        discovery: false,
        configuredCallback: false,
        flyCallback: false,
        configuredLogout: false,
        flyLogout: false,
      };
    }
    const discovery = await response.json();
    const discoveryOk =
      typeof discovery.authorization_endpoint === "string" &&
      typeof discovery.jwks_uri === "string" &&
      typeof discovery.token_endpoint === "string";
    if (!discoveryOk) {
      return {
        discovery: false,
        configuredCallback: false,
        flyCallback: false,
        configuredLogout: false,
        flyLogout: false,
      };
    }

    async function callbackIsAllowed(applicationBaseUrl) {
      const callback = new URL("/callback", applicationBaseUrl);
      const authorization = new URL(discovery.authorization_endpoint);
      authorization.searchParams.set("client_id", clientId);
      authorization.searchParams.set("redirect_uri", callback.toString());
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "openid");
      authorization.searchParams.set("state", "epyhia-configuration-check");
      authorization.searchParams.set("nonce", "epyhia-configuration-check");
      authorization.searchParams.set("prompt", "none");
      const authorizationResponse = await fetch(authorization, { redirect: "manual" });
      const location = authorizationResponse.headers.get("location");
      if (!location) return false;
      const redirect = new URL(location, issuer);
      return redirect.origin === callback.origin && redirect.pathname === callback.pathname;
    }

    async function logoutIsAllowed(applicationBaseUrl) {
      const returnTo = new URL(applicationBaseUrl);
      const logout = new URL("v2/logout", `${issuer.replace(/\/$/, "")}/`);
      logout.searchParams.set("client_id", clientId);
      logout.searchParams.set("returnTo", returnTo.toString());
      const logoutResponse = await fetch(logout, { redirect: "manual" });
      const location = logoutResponse.headers.get("location");
      if (!location) return false;
      const redirect = new URL(location, issuer);
      return redirect.origin === returnTo.origin && redirect.pathname === returnTo.pathname;
    }

    const flyBaseUrl = `https://${flyAppPrefix}-web.fly.dev`;
    const [configuredCallback, flyCallback, configuredLogout, flyLogout] = await Promise.all([
      callbackIsAllowed(baseUrl),
      callbackIsAllowed(flyBaseUrl),
      logoutIsAllowed(baseUrl),
      logoutIsAllowed(flyBaseUrl),
    ]);
    return {
      discovery: true,
      configuredCallback,
      flyCallback,
      configuredLogout,
      flyLogout,
    };
  } catch {
    return {
      discovery: false,
      configuredCallback: false,
      flyCallback: false,
      configuredLogout: false,
      flyLogout: false,
    };
  }
}

async function r2Check() {
  const required = [
    "CLOUDFLARE_R2_TOKEN",
    "CLOUDFLARE_R2_ACCESS_KEY_ID",
    "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_R2_S3_URL",
    "CLOUDFLARE_ACCOUNT_ID",
    "R2_BUCKET",
  ];
  if (required.some((key) => !process.env[key])) {
    return { ok: false, detail: "missing required R2 configuration" };
  }
  const endpoint = new URL(process.env.CLOUDFLARE_R2_S3_URL);
  if (!endpoint.hostname.startsWith(`${process.env.CLOUDFLARE_ACCOUNT_ID}.`)) {
    return { ok: false, detail: "S3 URL account does not match CLOUDFLARE_ACCOUNT_ID" };
  }
  const wrangler = resolve(root, "node_modules/.bin/wrangler");
  const result = await run(wrangler, ["r2", "bucket", "list"], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_R2_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    CI: "1",
  });
  if (!result.ok) {
    return { ok: false, detail: sanitize(result.stderr) };
  }

  try {
    const client = new S3Client({
      region: "auto",
      endpoint: endpoint.toString(),
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });
    await client.send(
      new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        MaxKeys: 1,
      }),
    );
  } catch (error) {
    return {
      ok: false,
      detail: `S3 bucket access failed: ${sanitize(error?.message) || "unknown error"}`,
    };
  }

  return {
    ok: true,
    detail: "account token and S3 bucket credentials accepted",
  };
}

async function flyCheck() {
  if (!process.env.FLY_ORG_TOKEN) {
    return { auth: false, organizations: [], detail: "missing FLY_ORG_TOKEN" };
  }
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FLY_API_TOKEN: process.env.FLY_ORG_TOKEN,
  };
  const auth = await run("flyctl", ["auth", "whoami"], env);
  const organizations = await run("flyctl", ["orgs", "list", "--json"], env);
  let organizationSlugs = [];
  if (organizations.ok) {
    try {
      const body = JSON.parse(organizations.stdout);
      organizationSlugs = Array.isArray(body)
        ? body.map((org) => org.slug ?? org.Slug).filter(Boolean)
        : body && typeof body === "object"
          ? Object.keys(body)
          : [];
    } catch {
      organizationSlugs = [];
    }
  }
  const configuredSlugVisible = organizationSlugs.includes(process.env.FLY_ORG);
  const configuredOrg = configuredSlugVisible
    ? await run(
        "flyctl",
        ["apps", "list", "--org", process.env.FLY_ORG, "--json"],
        env,
      )
    : { ok: false, stderr: "FLY_ORG is not an organization slug visible to this token" };
  return {
    auth: auth.ok,
    configuredOrg: configuredOrg.ok,
    organizationsAccessible: organizations.ok && organizationSlugs.length > 0,
    detail: auth.ok ? "authenticated" : sanitize(auth.stderr),
    orgDetail: configuredOrg.ok ? "configured organization accessible" : sanitize(configuredOrg.stderr),
  };
}

const [auth0, r2, fly] = await Promise.all([auth0Check(), r2Check(), flyCheck()]);
process.stdout.write(`Auth0 OIDC discovery: ${auth0.discovery ? "ok" : "failed"}\n`);
process.stdout.write(
  `Auth0 configured BASE_URL callback: ${auth0.configuredCallback ? "ok" : "failed"}\n`,
);
process.stdout.write(
  `Auth0 derived Fly callback: ${auth0.flyCallback ? "ok" : "failed"}\n`,
);
process.stdout.write(
  `Auth0 configured BASE_URL logout: ${auth0.configuredLogout ? "ok" : "failed"}\n`,
);
process.stdout.write(
  `Auth0 derived Fly logout: ${auth0.flyLogout ? "ok" : "failed"}\n`,
);
process.stdout.write(`Cloudflare R2 access: ${r2.ok ? "ok" : "failed"}\n`);
if (!r2.ok) process.stdout.write(`R2 diagnostic: ${r2.detail || "unavailable"}\n`);
process.stdout.write(`Fly token authentication: ${fly.auth ? "ok" : "failed"}\n`);
if (!fly.auth) process.stdout.write(`Fly diagnostic: ${fly.detail || "unavailable"}\n`);
process.stdout.write(
  `Fly configured organization access: ${fly.configuredOrg ? "ok" : "failed"}\n`,
);
if (!fly.configuredOrg) {
  process.stdout.write(`Fly organization diagnostic: ${fly.orgDetail || "unavailable"}\n`);
}
process.stdout.write(
  `Fly organization listing: ${fly.organizationsAccessible ? "ok" : "unavailable"}\n`,
);

if (
  !auth0.discovery ||
  !auth0.configuredCallback ||
  !auth0.flyCallback ||
  !auth0.configuredLogout ||
  !auth0.flyLogout ||
  !r2.ok ||
  !fly.auth ||
  !fly.configuredOrg
) {
  process.exitCode = 1;
}
