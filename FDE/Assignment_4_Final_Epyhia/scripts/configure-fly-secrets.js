import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("flyctl", args, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FLY_API_TOKEN: required("FLY_ORG_TOKEN"),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.replace(/\s+/g, " ").trim().slice(0, 500)));
    });
  });
}

const prefix = required("FLY_APP_PREFIX");
const appNames = {
  gate: `${prefix}-gate`,
  runtime: `${prefix}-runtime`,
  web: `${prefix}-web`,
};

const gateSecrets = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "STRIPE_SANDBOX_PUBLISHABLE_KEY",
  "STRIPE_SANDBOX_SECRET_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_R2_TOKEN",
  "CLOUDFLARE_R2_ACCESS_KEY_ID",
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_R2_S3_URL",
  "R2_BUCKET",
  "WEB_BUILDER_CAPABILITY_HANDLE",
  "ADMIN_APPROVAL_CAPABILITY_HANDLE",
  "RUNTIME_CONTROL_CAPABILITY_HANDLE",
  "STRATEGIST_CAPABILITY_HANDLE",
  "OPS_CAPABILITY_HANDLE",
  "MARKETER_CAPABILITY_HANDLE",
];
if (process.env.STRIPE_WEBHOOK_SECRET) gateSecrets.push("STRIPE_WEBHOOK_SECRET");
const runtimeSecrets = [
  "TIER1_RUNTIME_CAPABILITY_HANDLE",
  "WEB_BUILDER_CAPABILITY_HANDLE",
  "ADMIN_APPROVAL_CAPABILITY_HANDLE",
  "RUNTIME_CONTROL_CAPABILITY_HANDLE",
  "STRATEGIST_CAPABILITY_HANDLE",
  "OPS_CAPABILITY_HANDLE",
  "MARKETER_CAPABILITY_HANDLE",
];
const webSecrets = [
  "TIER1_RUNTIME_CAPABILITY_HANDLE",
  "ISSUER_BASE_URL",
  "CLIENT_ID",
  "SECRET",
  "BASE_URL",
];

async function stage(app, entries) {
  await run([
    "secrets",
    "set",
    "--stage",
    "--app",
    app,
    ...entries.map(([name, value]) => `${name}=${value}`),
  ]);
  process.stdout.write(`${app}: staged ${entries.length} exact secrets\n`);
}

async function verifyBoundary(app, requiredNames, allowedNames = requiredNames) {
  const raw = await run(["secrets", "list", "--app", app, "--json"]);
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new Error(`Fly returned invalid secret metadata for ${app}`);
  }
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== "string")) {
    throw new Error(`Fly returned unexpected secret metadata for ${app}`);
  }
  const remote = new Set(rows.map((row) => row.name));
  const missing = requiredNames.filter((name) => !remote.has(name));
  const extras = [...remote].filter((name) => !allowedNames.includes(name));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error(
      `${app} secret boundary mismatch; missing: ${missing.join(", ") || "none"}; disallowed: ${extras.join(", ") || "none"}`,
    );
  }
  process.stdout.write(`${app}: verified ${remote.size} allowed remote secret names\n`);
}

async function googleSecretEntries() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const credentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialsJson = process.env.GOOGLE_CLOUD_CREDENTIALS_JSON;
  if (!project && !credentialsFile && !credentialsJson) return [];
  if (!project || Boolean(credentialsFile) === Boolean(credentialsJson)) {
    throw new Error(
      "Veo staging requires GOOGLE_CLOUD_PROJECT and exactly one Google credential source",
    );
  }
  let rawCredentials = credentialsJson;
  if (credentialsFile) rawCredentials = await readFile(credentialsFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(rawCredentials);
  } catch {
    throw new Error("Google service-account credentials must contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google service-account credentials must contain an object");
  }
  return [
    ["GOOGLE_CLOUD_PROJECT", project],
    ["GOOGLE_CLOUD_CREDENTIALS_JSON", JSON.stringify(parsed)],
    ["GOOGLE_CLOUD_LOCATION", process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"],
  ];
}

const googleEntries = await googleSecretEntries();
const gateEntries = [
  ...gateSecrets.map((name) => [name, required(name)]),
  ...googleEntries,
];
const runtimeEntries = [
  ["ACTION_GATE_URL", `http://${appNames.gate}.internal:4100`],
  ["PUBLIC_API_BASE_URL", `https://${appNames.web}.fly.dev`],
  ...runtimeSecrets.map((name) => [name, required(name)]),
];
const webEntries = [
  ["RUNTIME_URL", `http://${appNames.runtime}.internal:4200`],
  ...webSecrets.map((name) => [name, required(name)]),
];

await stage(appNames.gate, gateEntries);
await stage(appNames.runtime, runtimeEntries);
await stage(appNames.web, webEntries);

const possibleGateNames = [
  ...gateSecrets,
  "STRIPE_WEBHOOK_SECRET",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_CREDENTIALS_JSON",
  "GOOGLE_CLOUD_LOCATION",
];
await verifyBoundary(
  appNames.gate,
  gateEntries.map(([name]) => name),
  [...new Set(possibleGateNames)],
);
await verifyBoundary(appNames.runtime, runtimeEntries.map(([name]) => name));
await verifyBoundary(appNames.web, webEntries.map(([name]) => name));
