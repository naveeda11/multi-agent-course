import { AppError } from "../shared/errors.js";

async function parseResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new AppError(body.error?.message ?? "Runtime request failed", {
      code: body.error?.code ?? "RUNTIME_ERROR",
      status: response.status,
      details: body.error?.details,
    });
  }
  return body;
}

export class RuntimeClient {
  constructor({ baseUrl, capabilityHandle, fetchImpl = fetch }) {
    if (!/^[A-Za-z0-9]{32,200}$/.test(capabilityHandle ?? "")) {
      throw new Error(
        "TIER1_RUNTIME_CAPABILITY_HANDLE must be 32-200 alphanumeric characters",
      );
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.capabilityHandle = capabilityHandle;
    this.fetch = fetchImpl;
  }

  headers(additional = {}) {
    return {
      authorization: `Bearer ${this.capabilityHandle}`,
      ...additional,
    };
  }

  async onboard(input, idempotencyKey) {
    const response = await this.fetch(`${this.baseUrl}/v1/onboarding`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      }),
      body: JSON.stringify(input),
    });
    return parseResponse(response);
  }

  async createCheckoutSession(input, idempotencyKey) {
    const response = await this.fetch(`${this.baseUrl}/v1/checkout-session`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      }),
      body: JSON.stringify(input),
    });
    return parseResponse(response);
  }

  async forwardStripeWebhook(rawBody, signature) {
    const response = await this.fetch(`${this.baseUrl}/v1/stripe/webhook`, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        "stripe-signature": signature,
      }),
      body: rawBody,
    });
    return parseResponse(response);
  }

  async readOrderStatus(reservationId, siteOrigin) {
    const url = new URL(`${this.baseUrl}/v1/orders/${encodeURIComponent(reservationId)}`);
    url.searchParams.set("siteOrigin", siteOrigin);
    const response = await this.fetch(url, { headers: this.headers() });
    return parseResponse(response);
  }

  async readRunStatus({ tenantId, runId }) {
    const url = new URL(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/status`,
    );
    url.searchParams.set("tenantId", tenantId);
    const response = await this.fetch(url, { headers: this.headers() });
    return parseResponse(response);
  }

  async readRunAudit({ tenantId, runId }) {
    const url = new URL(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/audit`,
    );
    url.searchParams.set("tenantId", tenantId);
    const response = await this.fetch(url, { headers: this.headers() });
    return parseResponse(response);
  }

  async readTenantProfile({ tenantId }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/profile`,
      { headers: this.headers() },
    );
    return parseResponse(response);
  }

  async createMarketingPack({ tenantId, runId }, idempotencyKey) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/marketing`,
      {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        }),
        body: JSON.stringify({ tenantId }),
      },
    );
    return parseResponse(response);
  }

  async buildWebsite({ tenantId, runId }, idempotencyKey) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/web-build`,
      {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        }),
        body: JSON.stringify({ tenantId }),
      },
    );
    return parseResponse(response);
  }

  async approveAndExecuteDeployment({ actionId, payloadHash, approvedBy, tenantId }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}/approve-and-execute`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ payloadHash, approvedBy, tenantId }),
      },
    );
    return parseResponse(response);
  }

  async approveAndExecuteVideo({ actionId, payloadHash, approvedBy, tenantId }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}/approve-and-render`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ payloadHash, approvedBy, tenantId }),
      },
    );
    return parseResponse(response);
  }
}
