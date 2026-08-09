import { payloadHash as hashPayload, sha256 } from "../shared/canonical.js";
import {
  ApprovalRequiredError,
  ConflictError,
  ProviderError,
  ValidationError,
} from "../shared/errors.js";
import { ACTIONS } from "./capabilities.js";

const PROJECT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

function validateRequestId(value, label) {
  if (typeof value !== "string" || value.length < 3 || value.length > 200) {
    throw new ValidationError(`${label} must be a string between 3 and 200 characters`);
  }
}

function validateDeployPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ValidationError("Deploy payload must be an object");
  }
  if (!PROJECT_NAME_PATTERN.test(payload.projectName ?? "")) {
    throw new ValidationError(
      "projectName must be a lowercase Cloudflare-compatible name",
    );
  }
  if (!payload.files || typeof payload.files !== "object" || Array.isArray(payload.files)) {
    throw new ValidationError("files must be an object keyed by safe relative paths");
  }
  const entries = Object.entries(payload.files);
  if (!Object.hasOwn(payload.files, "index.html")) {
    throw new ValidationError("A deployment must include index.html");
  }
  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new ValidationError(`A deployment must contain between 1 and ${MAX_FILES} files`);
  }

  let totalBytes = 0;
  for (const [path, content] of entries) {
    if (
      path.startsWith("/") ||
      path.includes("..") ||
      path.includes("\\") ||
      !/^[A-Za-z0-9._/-]+$/.test(path)
    ) {
      throw new ValidationError(`Unsafe deployment path: ${path}`);
    }
    if (typeof content !== "string") {
      throw new ValidationError(`Deployment file ${path} must contain text`);
    }
    totalBytes += Buffer.byteLength(content);
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ValidationError("Deployment payload exceeds the 5 MiB gate limit");
  }
}

function deploymentEvidence(row) {
  if (!row) return null;
  return {
    liveUrl: row.live_url,
    verifiedAt: row.verified_at,
    projectName: row.cloudflare_project_name,
  };
}

export class ActionGate {
  constructor({
    repository,
    capabilities,
    deploymentProvider,
    onboardingService,
    modelService,
    checkoutService,
    catalogService,
    marketingService,
    siteService,
    videoService,
    erasureService,
    maxDeployAttempts = 2,
  }) {
    this.repository = repository;
    this.capabilities = capabilities;
    this.deploymentProvider = deploymentProvider;
    this.onboardingService = onboardingService;
    this.modelService = modelService;
    this.checkoutService = checkoutService;
    this.catalogService = catalogService;
    this.marketingService = marketingService;
    this.siteService = siteService;
    this.videoService = videoService;
    this.erasureService = erasureService;
    this.maxDeployAttempts = maxDeployAttempts;
  }

  async createRunShell({ capabilityHandle, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "orchestration-runtime",
      action: ACTIONS.CREATE_RUN_SHELL,
    });
    if (!this.onboardingService) {
      throw new ConflictError("Onboarding persistence is not configured");
    }
    return this.onboardingService.createRunShell({
      ...input,
      requestedBy: "orchestration-runtime",
    });
  }

  async finalizeRun({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.FINALIZE_RUN,
    });
    if (!this.onboardingService) {
      throw new ConflictError("Onboarding persistence is not configured");
    }
    return this.onboardingService.finalizeRun({ ...input, agentName });
  }

  async approveBrandDocument({ capabilityHandle, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.APPROVE_BRAND_DOCUMENT,
    });
    if (!this.onboardingService) {
      throw new ConflictError("Onboarding persistence is not configured");
    }
    return this.onboardingService.approveBrandDocument(input);
  }

  async createArtifactRevision({ capabilityHandle, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.CREATE_ARTIFACT_REVISION,
    });
    if (!this.onboardingService) {
      throw new ConflictError("Onboarding persistence is not configured");
    }
    return this.onboardingService.createArtifactRevision(input);
  }

  async modelCall({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.MODEL_CALL,
    });
    if (!this.modelService) {
      throw new ConflictError("The model provider is not configured");
    }
    return this.modelService.call({ ...input, agentName });
  }

  async createCheckoutSession({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.CREATE_CHECKOUT_SESSION,
    });
    if (!this.checkoutService) {
      throw new ConflictError("Stripe sandbox checkout is not configured");
    }
    return this.checkoutService.createSession(input);
  }

  async processStripeWebhook({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.PROCESS_STRIPE_WEBHOOK,
    });
    if (!this.checkoutService) {
      throw new ConflictError("Stripe sandbox checkout is not configured");
    }
    return this.checkoutService.processWebhook(input);
  }

  async persistCatalog({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.PERSIST_CATALOG,
    });
    if (!this.catalogService) {
      throw new ConflictError("Catalog persistence is not configured");
    }
    return this.catalogService.persist({ ...input, agentName });
  }

  async readOrderStatus({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.READ_ORDER_STATUS,
    });
    if (!this.checkoutService) {
      throw new ConflictError("Order persistence is not configured");
    }
    return this.checkoutService.readOrderStatus(input);
  }

  async readRunContext({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.READ_RUN_CONTEXT,
    });
    if (!this.repository?.readRunContext) {
      throw new ConflictError("Run persistence is not configured");
    }
    const context = await this.repository.readRunContext(input);
    if (
      ["web-builder", "marketer"].includes(agentName) &&
      context.brandDocument.approvalStatus !== "APPROVED"
    ) {
      throw new ApprovalRequiredError("Brand document approval is required");
    }
    return context;
  }

  async readRunDeliverables({ capabilityHandle, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.READ_RUN_DELIVERABLES,
    });
    if (!this.repository?.readRunDeliverables) {
      throw new ConflictError("Run deliverable persistence is not configured");
    }
    return this.repository.readRunDeliverables(input);
  }

  async persistMarketingPack({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.PERSIST_MARKETING_PACK,
    });
    if (!this.marketingService) {
      throw new ConflictError("Marketing persistence is not configured");
    }
    return this.marketingService.persistPack({ ...input, agentName });
  }

  async approveMarketingPack({ capabilityHandle, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.APPROVE_MARKETING_PACK,
    });
    if (!this.marketingService) {
      throw new ConflictError("Marketing persistence is not configured");
    }
    return this.marketingService.approvePack(input);
  }

  async persistSiteArtifact({ capabilityHandle, agentName, ...input }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.PERSIST_SITE_ARTIFACT,
    });
    if (!this.siteService) {
      throw new ConflictError("Site artifact persistence is not configured");
    }
    return this.siteService.persist({ ...input, agentName });
  }

  async executeVideoRender({ capabilityHandle, actionId, agentName }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.VIDEO_RENDER,
    });
    if (!this.videoService) {
      throw new ConflictError("Veo is not configured on the Action Gate");
    }
    return this.videoService.execute({ actionId, agentName });
  }

  async requestDeploy({
    capabilityHandle,
    tenantId,
    runId,
    agentName,
    idempotencyKey,
    mode = "TEST",
    payload,
  }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.DEPLOY,
    });
    validateRequestId(tenantId, "tenantId");
    validateRequestId(runId, "runId");
    validateRequestId(idempotencyKey, "idempotencyKey");
    if (!['TEST', 'LIVE'].includes(mode)) {
      throw new ValidationError("mode must be TEST or LIVE");
    }
    if (mode === "LIVE" && this.deploymentProvider.mode !== "LIVE") {
      throw new ConflictError("The configured provider cannot execute LIVE deployments");
    }
    if (mode === "TEST" && this.deploymentProvider.mode !== "TEST") {
      throw new ConflictError("The configured provider cannot execute TEST deployments");
    }
    validateDeployPayload(payload);
    const deployment = await this.repository.getDeployment(tenantId);
    if (deployment && deployment.cloudflare_project_name !== payload.projectName) {
      throw new ConflictError(
        "A tenant deployment is permanently bound to its existing project",
        { projectName: deployment.cloudflare_project_name },
      );
    }

    return this.repository.createPendingAction({
      tenantId,
      runId,
      agentName,
      actionType: ACTIONS.DEPLOY,
      payloadHash: hashPayload(payload),
      idempotencyKey,
      mode,
      payload,
      approvalRequired: true,
    });
  }

  async approve({ capabilityHandle, actionId, payloadHash, approvedBy, tenantId }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.APPROVE,
    });
    validateRequestId(actionId, "actionId");
    validateRequestId(tenantId, "tenantId");
    validateRequestId(approvedBy, "approvedBy");
    if (!/^[a-f0-9]{64}$/.test(payloadHash ?? "")) {
      throw new ValidationError("payloadHash must be a SHA-256 hex digest");
    }
    return this.repository.approveAction({ actionId, payloadHash, approvedBy, tenantId });
  }

  async readAudit({ capabilityHandle, actionId, subject }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.READ_AUDIT,
    });
    return this.repository.requireAction(actionId);
  }

  async readRunAudit({ capabilityHandle, tenantId, runId }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.READ_RUN_AUDIT,
    });
    validateRequestId(tenantId, "tenantId");
    validateRequestId(runId, "runId");
    if (!this.repository?.readRunAudit) {
      throw new ConflictError("Run audit persistence is not configured");
    }
    return this.repository.readRunAudit({ tenantId, runId });
  }

  async readTenantProfile({ capabilityHandle, tenantId }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.READ_TENANT_PROFILE,
    });
    validateRequestId(tenantId, "tenantId");
    if (!this.repository?.readTenantProfile) {
      throw new ConflictError("Tenant persistence is not configured");
    }
    return this.repository.readTenantProfile({ tenantId });
  }

  async eraseTenant({
    capabilityHandle,
    tenantId,
    auth0UserId,
    confirmation,
  }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: "admin",
      action: ACTIONS.ERASE_TENANT,
    });
    validateRequestId(tenantId, "tenantId");
    validateRequestId(auth0UserId, "auth0UserId");
    if (confirmation !== "DELETE") {
      throw new ValidationError("Tenant erasure requires explicit DELETE confirmation");
    }
    if (!this.erasureService) {
      throw new ConflictError("Tenant erasure is not configured");
    }
    return this.erasureService.erase({ tenantId });
  }

  async executeDeploy({ capabilityHandle, actionId, agentName }) {
    this.capabilities.authorize(capabilityHandle, {
      subject: agentName,
      action: ACTIONS.DEPLOY,
    });
    const originalAction = await this.repository.requireAction(actionId);
    if (originalAction.agentName !== agentName) {
      throw new ConflictError("Only the requesting agent may execute this action");
    }
    if (originalAction.actionType !== ACTIONS.DEPLOY) {
      throw new ConflictError("Action is not a deployment");
    }
    if (originalAction.status === "EXECUTED") {
      return {
        action: originalAction,
        deployment: deploymentEvidence(
          await this.repository.getDeployment(originalAction.tenantId),
        ),
        replayed: true,
      };
    }
    if (originalAction.approvalStatus !== "APPROVED") {
      throw new ApprovalRequiredError();
    }

    const { action, claimed } = await this.repository.claimForExecution(actionId);
    if (!claimed) {
      if (action.status === "EXECUTED") {
        return {
          action,
          deployment: deploymentEvidence(
            await this.repository.getDeployment(action.tenantId),
          ),
          replayed: true,
        };
      }
      throw new ApprovalRequiredError();
    }
    const payload = await this.repository.getPayload(actionId);

    let lastError;
    for (let attempt = 1; attempt <= this.maxDeployAttempts; attempt += 1) {
      try {
        const result = await this.deploymentProvider.deploy({
          tenantId: action.tenantId,
          runId: action.runId,
          actionId: action.id,
          projectName: payload.projectName,
          files: payload.files,
        });
        const verified = await this.deploymentProvider.verify(result.liveUrl, {
          tenantId: action.tenantId,
          projectName: payload.projectName,
          expectedContentHash: sha256(payload.files["index.html"]),
        });
        if (!verified) {
          throw new ProviderError("Deployment URL did not pass real-world verification", {
            liveUrl: result.liveUrl,
            attempt,
          });
        }
        const completed = await this.repository.completeDeployment({
          actionId: action.id,
          tenantId: action.tenantId,
          projectName: payload.projectName,
          providerReference: result.providerReference,
          providerCostMicrodollars: result.providerCostMicrodollars ?? 0,
          liveUrl: result.liveUrl,
          verifiedAt: new Date().toISOString(),
        });
        return {
          action: completed,
          deployment: {
            liveUrl: result.liveUrl,
            verifiedAt: completed.executedAt,
            projectName: payload.projectName,
          },
          replayed: false,
        };
      } catch (error) {
        lastError = error;
      }
    }

    await this.repository.failAction(actionId, lastError?.message ?? "Deployment failed");
    throw new ProviderError(
      "Deployment failed after one retry; the failure is logged for administrator review",
      {
        cause: lastError?.message,
      },
    );
  }
}
