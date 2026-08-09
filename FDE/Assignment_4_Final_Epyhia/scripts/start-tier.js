import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const commonKeys = ["NODE_ENV", "TZ", "PATH"];
const tierConfiguration = Object.freeze({
  gate: {
    entrypoint: "src/gate/server.js",
    keys: [
      "ACTION_GATE_HOST",
      "ACTION_GATE_PORT",
      "ACTION_GATE_AUTO_MIGRATE",
      "ACTION_GATE_DB_PATH",
      "DEPLOY_PROVIDER",
      "LOCAL_DEPLOY_ROOT",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "STRIPE_SANDBOX_PUBLISHABLE_KEY",
      "STRIPE_SANDBOX_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "AUTH0_MANAGEMENT_ISSUER_BASE_URL",
      "AUTH0_MANAGEMENT_CLIENT_ID",
      "AUTH0_MANAGEMENT_CLIENT_SECRET",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_R2_ACCESS_KEY_ID",
      "CLOUDFLARE_R2_SECRET_ACCESS_KEY",
      "CLOUDFLARE_R2_S3_URL",
      "R2_BUCKET",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_CREDENTIALS_JSON",
      "GOOGLE_CLOUD_LOCATION",
      "WEB_BUILDER_CAPABILITY_HANDLE",
      "ADMIN_APPROVAL_CAPABILITY_HANDLE",
      "RUNTIME_CONTROL_CAPABILITY_HANDLE",
      "STRATEGIST_CAPABILITY_HANDLE",
      "OPS_CAPABILITY_HANDLE",
      "MARKETER_CAPABILITY_HANDLE",
    ],
  },
  runtime: {
    entrypoint: "src/runtime/server.js",
    keys: [
      "ACTION_GATE_URL",
      "PUBLIC_API_BASE_URL",
      "RUNTIME_HOST",
      "RUNTIME_PORT",
      "WEB_BUILDER_CAPABILITY_HANDLE",
      "ADMIN_APPROVAL_CAPABILITY_HANDLE",
      "RUNTIME_CONTROL_CAPABILITY_HANDLE",
      "STRATEGIST_CAPABILITY_HANDLE",
      "OPS_CAPABILITY_HANDLE",
      "MARKETER_CAPABILITY_HANDLE",
      "TIER1_RUNTIME_CAPABILITY_HANDLE",
    ],
  },
  web: {
    entrypoint: "src/web/server.js",
    keys: [
      "RUNTIME_URL",
      "TIER1_RUNTIME_CAPABILITY_HANDLE",
      "ISSUER_BASE_URL",
      "CLIENT_ID",
      "SECRET",
      "BASE_URL",
      "PORT",
    ],
  },
});

export function buildTierEnvironment(tier, source = process.env) {
  const configuration = tierConfiguration[tier];
  if (!configuration) throw new Error(`Unknown EPYHIA tier: ${tier}`);
  const environment = {};
  for (const key of [...commonKeys, ...configuration.keys]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

function start(tier) {
  const configuration = tierConfiguration[tier];
  if (!configuration) throw new Error(`Unknown EPYHIA tier: ${tier}`);
  const child = spawn(process.execPath, [configuration.entrypoint], {
    cwd: root,
    env: buildTierEnvironment(tier),
    shell: false,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    process.stderr.write(`Unable to start ${tier}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start(process.argv[2]);
}
