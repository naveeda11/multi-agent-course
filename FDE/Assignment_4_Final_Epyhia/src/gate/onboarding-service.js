import { ValidationError } from "../shared/errors.js";

const TASK_TYPES = new Set(["CATALOG_PERSIST", "WEB_BUILD", "MARKETING_PACK"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_APPROVED_MODEL_BUDGET_MICRODOLLARS = 2_000_000;

function requiredString(value, name, { max = 20_000 } = {}) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ValidationError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function validateTenant(tenant) {
  if (!tenant || typeof tenant !== "object") {
    throw new ValidationError("tenant is required");
  }
  for (const field of [
    "id",
    "name",
    "email",
    "businessName",
    "businessSlug",
    "businessEmail",
    "businessPhone",
    "businessAddress",
  ]) {
    requiredString(tenant[field], `tenant.${field}`, { max: 500 });
  }
  if (!EMAIL_PATTERN.test(tenant.email) || !EMAIL_PATTERN.test(tenant.businessEmail)) {
    throw new ValidationError("tenant email fields must contain valid email addresses");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(tenant.businessSlug)) {
    throw new ValidationError("tenant.businessSlug must be a lowercase URL slug");
  }
}

function validateBudget(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_APPROVED_MODEL_BUDGET_MICRODOLLARS
  ) {
    throw new ValidationError(
      "approvedBudgetMicrodollars must be an integer between 0 and 2,000,000",
    );
  }
}

function validateTaskPlan(taskPlan) {
  if (!Array.isArray(taskPlan) || taskPlan.length !== TASK_TYPES.size) {
    throw new ValidationError("taskPlan must contain exactly the three required tasks");
  }
  const seen = new Set();
  for (const task of taskPlan) {
    if (!task || !TASK_TYPES.has(task.taskType)) {
      throw new ValidationError("taskPlan contains an unsupported task type");
    }
    if (seen.has(task.taskType)) {
      throw new ValidationError(`taskPlan repeats ${task.taskType}`);
    }
    seen.add(task.taskType);
  }
  if ([...TASK_TYPES].some((taskType) => !seen.has(taskType))) {
    throw new ValidationError("taskPlan must include Catalog, Web, and Marketing tasks");
  }
}

export class OnboardingService {
  constructor({ repository }) {
    this.repository = repository;
  }

  async createRunShell(input) {
    validateTenant(input.tenant);
    requiredString(input.originalBrief, "originalBrief", { max: 30_000 });
    requiredString(input.idempotencyKey, "idempotencyKey", { max: 200 });
    requiredString(input.approvedBy, "approvedBy", { max: 500 });
    validateBudget(input.approvedBudgetMicrodollars);
    return this.repository.createRunShell(input);
  }

  async finalizeRun(input) {
    requiredString(input.tenantId, "tenantId", { max: 200 });
    requiredString(input.runId, "runId", { max: 200 });
    requiredString(input.completedBrief, "completedBrief");
    requiredString(input.brandDocument, "brandDocument", { max: 100_000 });
    requiredString(input.idempotencyKey, "idempotencyKey", { max: 200 });
    validateTaskPlan(input.taskPlan);
    return this.repository.finalizeRun(input);
  }

  async approveBrandDocument(input) {
    requiredString(input.tenantId, "tenantId", { max: 200 });
    requiredString(input.runId, "runId", { max: 200 });
    requiredString(input.brandDocumentId, "brandDocumentId", { max: 200 });
    requiredString(input.approvedBy, "approvedBy", { max: 500 });
    requiredString(input.idempotencyKey, "idempotencyKey", { max: 200 });
    if (!/^[a-f0-9]{64}$/.test(input.contentHash ?? "")) {
      throw new ValidationError("contentHash must be a SHA-256 hex digest");
    }
    return this.repository.approveBrandDocument(input);
  }

  async createArtifactRevision(input) {
    requiredString(input.tenantId, "tenantId", { max: 200 });
    requiredString(input.sourceRunId, "sourceRunId", { max: 200 });
    requiredString(input.feedback, "feedback", { max: 5_000 });
    requiredString(input.approvedBy, "approvedBy", { max: 500 });
    requiredString(input.idempotencyKey, "idempotencyKey", { max: 200 });
    validateBudget(input.approvedBudgetMicrodollars);
    if (!["WEB_BUILD", "MARKETING_PACK"].includes(input.artifactType)) {
      throw new ValidationError("artifactType must be WEB_BUILD or MARKETING_PACK");
    }
    return this.repository.createArtifactRevision(input);
  }
}
