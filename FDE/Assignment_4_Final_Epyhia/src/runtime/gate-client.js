import { AppError } from "../shared/errors.js";

async function parseResponse(response) {
  const body = await response.json();
  if (!response.ok) {
    throw new AppError(body.error?.message ?? "Action Gate request failed", {
      code: body.error?.code ?? "GATE_ERROR",
      status: response.status,
      details: body.error?.details,
    });
  }
  return body;
}

export class ActionGateClient {
  constructor({ baseUrl, capabilityHandle, agentName, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.capabilityHandle = capabilityHandle;
    this.agentName = agentName;
    this.fetch = fetchImpl;
  }

  async requestDeploy({ tenantId, runId, idempotencyKey, mode, payload }) {
    const response = await this.fetch(`${this.baseUrl}/v1/actions/deploy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        tenantId,
        runId,
        agentName: this.agentName,
        mode,
        payload,
      }),
    });
    return parseResponse(response);
  }

  async createRunShell({
    tenant,
    originalBrief,
    approvedBudgetMicrodollars,
    approvedBy,
    idempotencyKey,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/onboarding/run-shell`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        tenant,
        originalBrief,
        approvedBudgetMicrodollars,
        approvedBy,
      }),
    });
    return parseResponse(response);
  }

  async modelCall({
    tenantId,
    runId,
    taskId,
    instructions,
    input,
    maxOutputTokens,
    responseSchema,
    idempotencyKey,
    purpose,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/model-call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        tenantId,
        runId,
        taskId,
        agentName: this.agentName,
        instructions,
        input,
        maxOutputTokens,
        responseSchema,
        purpose,
      }),
    });
    return parseResponse(response);
  }

  async finalizeRun({
    tenantId,
    runId,
    completedBrief,
    brandDocument,
    taskPlan,
    idempotencyKey,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/onboarding/finalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        tenantId,
        runId,
        completedBrief,
        brandDocument,
        taskPlan,
        agentName: this.agentName,
      }),
    });
    return parseResponse(response);
  }

  async approveBrandDocument({
    tenantId,
    runId,
    brandDocumentId,
    contentHash,
    approvedBy,
    idempotencyKey,
  }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/brand-document/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ tenantId, brandDocumentId, contentHash, approvedBy }),
      },
    );
    return parseResponse(response);
  }

  async executeDeploy(actionId) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}/execute`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentName: this.agentName }),
      },
    );
    return parseResponse(response);
  }

  async executeVideoRender(actionId) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}/execute-video`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentName: this.agentName }),
      },
    );
    return parseResponse(response);
  }

  async approveAction({ actionId, payloadHash, approvedBy, tenantId }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ payloadHash, approvedBy, tenantId }),
      },
    );
    return parseResponse(response);
  }

  async createCheckoutSession({
    siteOrigin,
    customer,
    startDate,
    endDate,
    items,
    successUrl,
    cancelUrl,
    idempotencyKey,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/checkout-session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        agentName: this.agentName,
        siteOrigin,
        customer,
        startDate,
        endDate,
        items,
        successUrl,
        cancelUrl,
      }),
    });
    return parseResponse(response);
  }

  async processStripeWebhook({ rawBody, signature }) {
    const response = await this.fetch(`${this.baseUrl}/v1/stripe/webhook`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "stripe-signature": signature,
        "x-agent-name": this.agentName,
      },
      body: rawBody,
    });
    return parseResponse(response);
  }

  async persistCatalog({ tenantId, runId, items, idempotencyKey }) {
    const response = await this.fetch(`${this.baseUrl}/v1/catalog`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        agentName: this.agentName,
        tenantId,
        runId,
        items,
      }),
    });
    return parseResponse(response);
  }

  async readOrderStatus(reservationId, siteOrigin) {
    const url = new URL(`${this.baseUrl}/v1/orders/${encodeURIComponent(reservationId)}`);
    url.searchParams.set("siteOrigin", siteOrigin);
    const response = await this.fetch(url, {
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "x-agent-name": this.agentName,
      },
    });
    return parseResponse(response);
  }

  async readRunContext({ tenantId, runId }) {
    const url = new URL(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/context`,
    );
    url.searchParams.set("tenantId", tenantId);
    const response = await this.fetch(url, {
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "x-agent-name": this.agentName,
      },
    });
    return parseResponse(response);
  }

  async readRunAudit({ tenantId, runId }) {
    const url = new URL(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/audit`,
    );
    url.searchParams.set("tenantId", tenantId);
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${this.capabilityHandle}` },
    });
    return parseResponse(response);
  }

  async readTenantProfile({ tenantId }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/profile`,
      { headers: { authorization: `Bearer ${this.capabilityHandle}` } },
    );
    return parseResponse(response);
  }

  async eraseTenant({ tenantId, auth0UserId, confirmation }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/profile`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ auth0UserId, confirmation }),
      },
    );
    return parseResponse(response);
  }

  async persistMarketingPack({
    tenantId,
    runId,
    pack,
    review,
    idempotencyKey,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/marketing-pack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        agentName: this.agentName,
        tenantId,
        runId,
        pack,
        review,
      }),
    });
    return parseResponse(response);
  }

  async approveMarketingPack({
    tenantId,
    runId,
    packHash,
    approvedBy,
    idempotencyKey,
  }) {
    const response = await this.fetch(
      `${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/marketing-pack/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.capabilityHandle}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ tenantId, packHash, approvedBy }),
      },
    );
    return parseResponse(response);
  }

  async persistSiteArtifact({
    tenantId,
    runId,
    html,
    publicApiBaseUrl,
    review,
    revisionNumber,
    idempotencyKey,
  }) {
    const response = await this.fetch(`${this.baseUrl}/v1/site-artifact`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.capabilityHandle}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        agentName: this.agentName,
        tenantId,
        runId,
        html,
        publicApiBaseUrl,
        review,
        revisionNumber,
      }),
    });
    return parseResponse(response);
  }
}
