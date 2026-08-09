import { createHash } from "node:crypto";
import { payloadHash } from "../shared/canonical.js";
import { ProviderError, ValidationError } from "../shared/errors.js";

export const MODEL_POLICY = Object.freeze({
  strategist: {
    model: "gpt-5.6-sol",
    tier: "sol",
    reasoningEffort: "high",
    inputRate: 5,
    cachedInputRate: 0.5,
    outputRate: 30,
  },
  "web-builder": {
    model: "gpt-5.6-sol",
    tier: "sol",
    reasoningEffort: "high",
    inputRate: 5,
    cachedInputRate: 0.5,
    outputRate: 30,
  },
  "web-builder:review": {
    model: "gpt-5.6-terra",
    tier: "terra",
    reasoningEffort: "medium",
    inputRate: 2,
    cachedInputRate: 0.2,
    outputRate: 12,
  },
  marketer: {
    model: "gpt-5.6-terra",
    tier: "terra",
    reasoningEffort: "medium",
    inputRate: 2,
    cachedInputRate: 0.2,
    outputRate: 12,
  },
  ops: {
    model: "gpt-5.6-luna",
    tier: "luna",
    reasoningEffort: "low",
    inputRate: 0.2,
    cachedInputRate: 0.02,
    outputRate: 1.2,
  },
});

function validateText(value, name, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ValidationError(`${name} must contain between 1 and ${max} characters`);
  }
}

function conservativeInputTokenBound(instructions, input, responseSchema) {
  const schemaText = responseSchema ? JSON.stringify(responseSchema) : "";
  // A token cannot encode less than one UTF-8 byte. Reserving by bytes plus
  // protocol overhead is deliberately conservative and prevents budget overrun.
  return Buffer.byteLength(`${instructions}${input}${schemaText}`, "utf8") + 512;
}

export function calculateCost(policy, usage) {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  return Math.ceil(
    uncached * policy.inputRate +
      cached * policy.cachedInputRate +
      usage.outputTokens * policy.outputRate,
  );
}

export class ModelService {
  constructor({ repository, provider }) {
    this.repository = repository;
    this.provider = provider;
  }

  async call({
    runId,
    taskId,
    tenantId,
    agentName,
    instructions,
    input,
    maxOutputTokens = 4_000,
    responseSchema,
    idempotencyKey,
    purpose = "default",
  }) {
    const policyKey = purpose === "default" ? agentName : `${agentName}:${purpose}`;
    const policy = MODEL_POLICY[policyKey];
    if (!policy) throw new ValidationError(`No model policy exists for ${agentName}`);
    validateText(purpose, "purpose", 50);
    validateText(runId, "runId", 200);
    validateText(tenantId, "tenantId", 200);
    validateText(instructions, "instructions", 30_000);
    validateText(input, "input", 200_000);
    validateText(idempotencyKey, "idempotencyKey", 200);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 20_000) {
      throw new ValidationError("maxOutputTokens must be an integer between 1 and 20,000");
    }

    const estimatedInput = conservativeInputTokenBound(
      instructions,
      input,
      responseSchema,
    );
    const reservedCostMicrodollars = Math.ceil(
      estimatedInput * policy.inputRate + maxOutputTokens * policy.outputRate,
    );
    const requestHash = payloadHash({
      tenantId,
      runId,
      taskId: taskId ?? null,
      agentName,
      purpose,
      modelId: policy.model,
      instructions,
      input,
      maxOutputTokens,
      responseSchema: responseSchema ?? null,
    });
    const reservation = await this.repository.reserveAgentCall({
      tenantId,
      runId,
      taskId,
      agentName,
      modelId: policy.model,
      modelTier: policy.tier,
      reservedCostMicrodollars,
      idempotencyKey,
      requestHash,
    });
    if (reservation.replayed) return reservation.result;

    try {
      const result = await this.provider.create({
        idempotencyKey: `epyhia-${reservation.callId}`,
        model: policy.model,
        instructions,
        input,
        maxOutputTokens,
        reasoningEffort: policy.reasoningEffort,
        responseSchema,
        safetyIdentifier: createHash("sha256")
          .update(`${tenantId}:${agentName}`)
          .digest("hex"),
      });
      const costMicrodollars = calculateCost(policy, result);
      await this.repository.completeAgentCall({
        callId: reservation.callId,
        inputTokens: result.inputTokens,
        cachedInputTokens: result.cachedInputTokens,
        outputTokens: result.outputTokens,
        costMicrodollars,
        providerReference: result.providerReference,
        outputText: result.outputText,
      });
      return {
        callId: reservation.callId,
        model: policy.model,
        outputText: result.outputText,
        usage: {
          inputTokens: result.inputTokens,
          cachedInputTokens: result.cachedInputTokens,
          outputTokens: result.outputTokens,
          costMicrodollars,
        },
        replayed: false,
      };
    } catch (error) {
      await this.repository.failAgentCall(reservation.callId, error.message);
      if (error instanceof ValidationError) throw error;
      throw new ProviderError("The gated model call failed", { cause: error.message });
    }
  }
}
