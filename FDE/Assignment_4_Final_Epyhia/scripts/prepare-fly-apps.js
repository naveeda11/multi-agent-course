import { spawn } from "node:child_process";

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
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.replace(/\s+/g, " ").trim().slice(0, 500)));
    });
  });
}

const organization = required("FLY_ORG");
const prefix = required("FLY_APP_PREFIX");
if (!/^[a-z0-9](?:[a-z0-9-]{1,27}[a-z0-9])?$/.test(prefix)) {
  throw new Error("FLY_APP_PREFIX must be a lowercase Fly-compatible prefix");
}
const desired = [`${prefix}-web`, `${prefix}-runtime`, `${prefix}-gate`];
const current = JSON.parse(await run(["apps", "list", "--org", organization, "--json"]));
const existingNames = new Set(current.map((app) => app.Name ?? app.name).filter(Boolean));

for (const appName of desired) {
  if (existingNames.has(appName)) {
    process.stdout.write(`${appName}: already exists\n`);
    continue;
  }
  await run(["apps", "create", appName, "--org", organization]);
  process.stdout.write(`${appName}: created\n`);
}
