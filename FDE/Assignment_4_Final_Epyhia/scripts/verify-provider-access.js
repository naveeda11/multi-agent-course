const checks = [];

async function check(name, requiredKeys, request, validate = (response) => response.ok) {
  const missing = requiredKeys.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    checks.push({ name, status: "missing configuration", missing });
    return;
  }
  try {
    const response = await request();
    checks.push({ name, status: (await validate(response)) ? "ok" : "failed" });
  } catch {
    checks.push({ name, status: "failed" });
  }
}

for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
  await check(
    `OpenAI model ${model}`,
    ["OPENAI_API_KEY"],
    () =>
      fetch(`https://api.openai.com/v1/models/${model}`, {
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      }),
  );
}

checks.push({
  name: "Stripe sandbox publishable key",
  status: process.env.STRIPE_SANDBOX_PUBLISHABLE_KEY?.startsWith("pk_test_")
    ? "ok"
    : "failed",
});

await check(
  "Stripe sandbox key",
  ["STRIPE_SANDBOX_SECRET_KEY"],
  () =>
    fetch("https://api.stripe.com/v1/balance", {
      headers: { authorization: `Bearer ${process.env.STRIPE_SANDBOX_SECRET_KEY}` },
    }),
  async (response) => {
    if (!response.ok) return false;
    const body = await response.json();
    return body.livemode === false;
  },
);

await check(
  "Cloudflare Pages token and account access",
  ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  () =>
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects`,
      {
        headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
      },
    ),
  async (response) => {
    if (!response.ok) return false;
    const body = await response.json();
    return body.success === true;
  },
);

for (const result of checks) {
  const suffix = result.missing ? ` (${result.missing.join(", ")})` : "";
  process.stdout.write(`${result.name}: ${result.status}${suffix}\n`);
}

if (checks.some(({ status }) => status === "failed")) process.exitCode = 1;
