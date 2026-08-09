import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderError } from "../../shared/errors.js";
import { sha256 } from "../../shared/canonical.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWrangler = resolve(moduleDirectory, "../../../node_modules/.bin/wrangler");

function assertConfiguration(value, name) {
  if (!value) throw new ProviderError(`Missing Tier 3 configuration: ${name}`);
}

function safeFile(root, relativePath) {
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new ProviderError("Unsafe path reached the Cloudflare provider");
  }
  return target;
}

function safeProviderDetail(value, env) {
  let detail = String(value ?? "");
  for (const secret of [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]) {
    if (secret) detail = detail.split(secret).join("[redacted]");
  }
  return detail
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function run(binary, args, env, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd,
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const detail = safeProviderDetail(stderr, env);
        reject(
          new ProviderError(
            detail ? `Wrangler deployment failed: ${detail}` : "Wrangler deployment failed",
            { code },
          ),
        );
      }
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export class CloudflareDeploymentProvider {
  constructor({
    accountId,
    apiToken,
    wranglerPath = defaultWrangler,
    fetchImpl = fetch,
    verificationAttempts = 10,
    verificationIntervalMs = 1_000,
  }) {
    assertConfiguration(accountId, "CLOUDFLARE_ACCOUNT_ID");
    assertConfiguration(apiToken, "CLOUDFLARE_API_TOKEN");
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.wranglerPath = wranglerPath;
    this.fetch = fetchImpl;
    this.verificationAttempts = verificationAttempts;
    this.verificationIntervalMs = verificationIntervalMs;
    this.mode = "LIVE";
  }

  async ensureProject(projectName) {
    const base = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/pages/projects`;
    const headers = { Authorization: `Bearer ${this.apiToken}` };
    const existing = await this.fetch(`${base}/${projectName}`, { headers });
    if (existing.ok) return;
    if (existing.status !== 404) {
      throw new ProviderError("Unable to inspect Cloudflare Pages project", {
        status: existing.status,
      });
    }
    const created = await this.fetch(base, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: projectName, production_branch: "main" }),
    });
    if (!created.ok) {
      throw new ProviderError("Unable to create Cloudflare Pages project", {
        status: created.status,
      });
    }
  }

  async deploy({ projectName, actionId, files }) {
    await this.ensureProject(projectName);
    const directory = await mkdtemp(resolve(tmpdir(), "epyhia-pages-"));
    try {
      for (const [path, content] of Object.entries(files)) {
        const target = safeFile(directory, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      const { stdout, stderr } = await run(
        this.wranglerPath,
        [
          "pages",
          "deploy",
          directory,
          "--project-name",
          projectName,
          "--branch",
          "main",
          "--commit-message",
          `EPYHIA action ${actionId}`,
        ],
        {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLOUDFLARE_ACCOUNT_ID: this.accountId,
          CLOUDFLARE_API_TOKEN: this.apiToken,
          CI: "1",
        },
        directory,
      );
      const output = `${stdout}\n${stderr}`;
      const urls = output.match(/https:\/\/[a-zA-Z0-9.-]+\.pages\.dev/g) ?? [];
      const liveUrl = `https://${projectName}.pages.dev`;
      return {
        providerReference: urls.at(-1) ?? liveUrl,
        providerCostMicrodollars: 0,
        liveUrl,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async verify(liveUrl, { expectedContentHash }) {
    for (let attempt = 1; attempt <= this.verificationAttempts; attempt += 1) {
      try {
        const verificationUrl = new URL(liveUrl);
        verificationUrl.searchParams.set("epyhia_verify", `${expectedContentHash.slice(0, 12)}-${attempt}`);
        const response = await this.fetch(verificationUrl, {
          redirect: "follow",
          cache: "no-store",
        });
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          response.status === 200 &&
          contentType.startsWith("text/html") &&
          sha256(await response.text()) === expectedContentHash
        ) {
          return true;
        }
      } catch {
        // A deployment can briefly be unavailable while Cloudflare propagates it.
      }
      if (attempt < this.verificationAttempts) await wait(this.verificationIntervalMs);
    }
    return false;
  }

  async deleteProject({ projectName, liveUrl }) {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/pages/projects/${encodeURIComponent(projectName)}`;
    const headers = { Authorization: `Bearer ${this.apiToken}` };
    const deleted = await this.fetch(endpoint, { method: "DELETE", headers });
    if (!deleted.ok && deleted.status !== 404) {
      throw new ProviderError("Unable to delete Cloudflare Pages project", {
        status: deleted.status,
      });
    }

    for (let attempt = 1; attempt <= this.verificationAttempts; attempt += 1) {
      const project = await this.fetch(endpoint, { headers, cache: "no-store" });
      let siteUnavailable = true;
      if (liveUrl) {
        try {
          const site = await this.fetch(`${liveUrl}?epyhia_deleted=${attempt}`, {
            redirect: "manual",
            cache: "no-store",
          });
          siteUnavailable = site.status !== 200;
        } catch {
          siteUnavailable = true;
        }
      }
      if (project.status === 404 && siteUnavailable) {
        return { projectName, liveUrl, deleted: true };
      }
      if (attempt < this.verificationAttempts) await wait(this.verificationIntervalMs);
    }
    throw new ProviderError("Cloudflare project deletion did not pass real-world verification", {
      projectName,
      liveUrl,
    });
  }
}
