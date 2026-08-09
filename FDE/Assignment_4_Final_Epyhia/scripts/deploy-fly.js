import { spawn } from "node:child_process";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("flyctl", args, {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FLY_API_TOKEN: required("FLY_ORG_TOKEN"),
        CI: "1",
        NO_COLOR: "1",
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
      if (code === 0) return resolvePromise(stdout);
      reject(new Error(stderr.replace(/\s+/g, " ").trim().slice(0, 1_000)));
    });
  });
}

const prefix = required("FLY_APP_PREFIX");
const deployments = [
  { tier: "Action Gate", app: `${prefix}-gate`, config: "deploy/fly.gate.toml" },
  { tier: "Runtime", app: `${prefix}-runtime`, config: "deploy/fly.runtime.toml" },
  { tier: "Web", app: `${prefix}-web`, config: "deploy/fly.web.toml" },
];

for (const deployment of deployments) {
  await run([
    "deploy",
    ".",
    "--app",
    deployment.app,
    "--config",
    deployment.config,
    "--remote-only",
    "--ha=false",
    "--now",
  ]);
  process.stdout.write(`${deployment.tier}: deployed\n`);
}

const healthUrl = `https://${prefix}-web.fly.dev/health`;
const health = await fetch(healthUrl, { redirect: "follow" });
if (!health.ok) throw new Error(`Tier 1 health verification failed with HTTP ${health.status}`);
const body = await health.json();
if (body.status !== "ok" || body.tier !== 1) {
  throw new Error("Tier 1 health response did not identify the public web tier");
}
process.stdout.write(`Tier 1: verified ${healthUrl}\n`);
