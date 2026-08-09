import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const DESCRIPTION = "EPYHIA sandbox order persistence";
const ENABLED_EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
];
const RECOVERY_WINDOW_SECONDS = 23 * 60 * 60;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function webhookIdempotencyKey(webhookUrl) {
  const suffix = createHash("sha256").update(webhookUrl).digest("hex").slice(0, 32);
  return `epyhia-webhook-${suffix}`;
}

function endpointInput(webhookUrl) {
  return {
    url: webhookUrl,
    enabled_events: ENABLED_EVENTS,
    description: DESCRIPTION,
    metadata: {
      epyhia_namespace: "epyhia-demo",
      epyhia_purpose: "order-persistence",
      epyhia_setup_version: "v2",
    },
  };
}

export async function ensureStripeWebhook({
  stripe,
  webhookUrl,
  signingSecret,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const atUrl = endpoints.data.filter((endpoint) => endpoint.url === webhookUrl);
  if (atUrl.length > 1) {
    throw new Error(
      "Multiple Stripe endpoints use the EPYHIA webhook URL; resolve them explicitly before continuing",
    );
  }
  const existing = atUrl[0];
  if (existing && existing.description !== DESCRIPTION) {
    throw new Error(
      "The EPYHIA webhook URL belongs to an endpoint with a different description",
    );
  }
  if (existing && existing.livemode !== false) {
    throw new Error("The Action Gate refuses a live-mode Stripe webhook endpoint");
  }

  const input = endpointInput(webhookUrl);
  const idempotencyKey = webhookIdempotencyKey(webhookUrl);
  let endpoint = existing;
  let secret = signingSecret;
  let recovered = false;

  if (!existing) {
    endpoint = await stripe.webhookEndpoints.create(input, { idempotencyKey });
    secret = endpoint.secret;
  } else if (!secret) {
    if (existing.metadata?.epyhia_setup_version !== "v2") {
      throw new Error(
        "The existing EPYHIA endpoint was not created by the recoverable setup; add the exact STRIPE_WEBHOOK_SECRET before retrying",
      );
    }
    const ageSeconds = nowSeconds - Number(existing.created);
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds < 0 ||
      ageSeconds > RECOVERY_WINDOW_SECONDS
    ) {
      throw new Error(
        "The existing EPYHIA endpoint secret is unavailable outside Stripe's safe idempotency recovery window; add the exact STRIPE_WEBHOOK_SECRET before retrying",
      );
    }
    const replay = await stripe.webhookEndpoints.create(input, { idempotencyKey });
    if (replay.id !== existing.id) {
      throw new Error("Stripe did not replay the existing EPYHIA webhook endpoint");
    }
    endpoint = replay;
    secret = replay.secret;
    recovered = true;
  } else {
    endpoint = await stripe.webhookEndpoints.update(existing.id, {
      enabled_events: ENABLED_EVENTS,
      disabled: false,
      description: DESCRIPTION,
      metadata: input.metadata,
    });
  }

  if (endpoint?.livemode !== false || !secret?.startsWith("whsec_")) {
    throw new Error("Stripe did not return a valid test webhook and signing secret");
  }
  return {
    endpointId: endpoint.id,
    signingSecret: secret,
    created: !existing,
    recovered,
  };
}

function runFly(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("flyctl", args, {
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
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.replace(/\s+/g, " ").trim().slice(0, 500)));
    });
  });
}

async function listFlySecretNames(app) {
  const raw = await runFly(["secrets", "list", "--app", app, "--json"]);
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new Error(`Fly returned invalid secret metadata for ${app}`);
  }
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.name !== "string")) {
    throw new Error(`Fly returned unexpected secret metadata for ${app}`);
  }
  return new Set(rows.map((row) => row.name));
}

async function main() {
  const secretKey = required("STRIPE_SANDBOX_SECRET_KEY");
  if (!secretKey.startsWith("sk_test_")) {
    throw new Error("STRIPE_SANDBOX_SECRET_KEY must be a Stripe test key");
  }
  const prefix = required("FLY_APP_PREFIX");
  const gateApp = `${prefix}-gate`;
  const webhookUrl = `https://${prefix}-web.fly.dev/stripe/webhook`;
  const health = await fetch(`https://${prefix}-web.fly.dev/health`, {
    redirect: "follow",
  });
  if (!health.ok) {
    throw new Error("Tier 1 must be deployed and healthy before creating the Stripe webhook");
  }

  // Confirm Fly access before asking Stripe to reveal a creation-only secret.
  await listFlySecretNames(gateApp);
  const result = await ensureStripeWebhook({
    stripe: new Stripe(secretKey),
    webhookUrl,
    signingSecret: process.env.STRIPE_WEBHOOK_SECRET,
  });
  await runFly([
    "secrets",
    "set",
    "--app",
    gateApp,
    `STRIPE_WEBHOOK_SECRET=${result.signingSecret}`,
  ]);
  const remoteNames = await listFlySecretNames(gateApp);
  if (!remoteNames.has("STRIPE_WEBHOOK_SECRET")) {
    throw new Error("Fly did not confirm the Tier 3 Stripe webhook secret name");
  }
  process.stdout.write(
    `Stripe sandbox webhook ${result.endpointId}: configured and Tier 3 secret name verified\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Stripe webhook configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
