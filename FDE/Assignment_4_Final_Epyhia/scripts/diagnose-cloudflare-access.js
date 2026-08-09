const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
}

async function diagnose(name, url) {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => ({}));
    const errors = Array.isArray(body.errors)
      ? body.errors.map(({ code, message }) => ({ code, message }))
      : [];
    process.stdout.write(
      `${name}: HTTP ${response.status}; ${JSON.stringify(errors)}\n`,
    );
  } catch {
    process.stdout.write(`${name}: network failure\n`);
  }
}

await diagnose(
  "token verification",
  "https://api.cloudflare.com/client/v4/user/tokens/verify",
);
await diagnose(
  "Pages account access",
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`,
);
