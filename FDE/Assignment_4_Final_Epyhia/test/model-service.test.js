import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { calculateCost, MODEL_POLICY, ModelService } from "../src/gate/model-service.js";
import { ConflictError } from "../src/shared/errors.js";

class FakeModelRepository {
  constructor() {
    this.reservations = [];
    this.completions = [];
    this.failures = [];
  }

  async reserveAgentCall(input) {
    this.reservations.push(input);
    return {
      callId: "call_test",
      remainingBudgetMicrodollars: 1_000_000,
      replayed: false,
    };
  }

  async completeAgentCall(input) {
    this.completions.push(input);
  }

  async failAgentCall(callId, message) {
    this.failures.push({ callId, message });
  }
}

describe("gated model calls", () => {
  test("uses the agent's fixed model and logs exact token cost", async () => {
    const repository = new FakeModelRepository();
    const providerCalls = [];
    const service = new ModelService({
      repository,
      provider: {
        async create(input) {
          providerCalls.push(input);
          return {
            providerReference: "resp_1",
            outputText: '{"ok":true}',
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 50,
          };
        },
      },
    });

    const result = await service.call({
      runId: "run_test",
      tenantId: "tenant_test",
      agentName: "strategist",
      instructions: "Create a grounded business plan.",
      input: "Party rentals for local families.",
      maxOutputTokens: 500,
      idempotencyKey: "strategist-plan-v1",
    });

    assert.equal(providerCalls[0].model, "gpt-5.6-sol");
    assert.equal(providerCalls[0].idempotencyKey, "epyhia-call_test");
    assert.equal(providerCalls[0].reasoningEffort, "high");
    assert.match(providerCalls[0].safetyIdentifier, /^[a-f0-9]{64}$/);
    assert.equal(repository.reservations[0].modelId, "gpt-5.6-sol");
    assert.equal(repository.reservations[0].tenantId, "tenant_test");
    assert.ok(repository.reservations[0].reservedCostMicrodollars > 0);
    assert.equal(repository.reservations[0].idempotencyKey, "strategist-plan-v1");
    assert.match(repository.reservations[0].requestHash, /^[a-f0-9]{64}$/);
    assert.equal(result.usage.costMicrodollars, 1_910);
    assert.equal(repository.completions[0].costMicrodollars, 1_910);
    assert.equal(repository.failures.length, 0);
  });

  test("does not call the provider when the run budget rejects the reservation", async () => {
    let providerCalled = false;
    const service = new ModelService({
      repository: {
        async reserveAgentCall() {
          throw new ConflictError("budget exceeded");
        },
      },
      provider: {
        async create() {
          providerCalled = true;
        },
      },
    });

    await assert.rejects(
      service.call({
        runId: "run_test",
        tenantId: "tenant_test",
        agentName: "strategist",
        instructions: "Plan.",
        input: "Brief.",
        maxOutputTokens: 100,
        idempotencyKey: "strategist-plan-v1",
      }),
      ConflictError,
    );
    assert.equal(providerCalled, false);
  });

  test("uses integer microdollars for fractional Luna rates", () => {
    assert.equal(
      calculateCost(MODEL_POLICY.ops, {
        inputTokens: 3,
        cachedInputTokens: 1,
        outputTokens: 2,
      }),
      3,
    );
  });

  test("uses the fixed Terra policy for Web Builder review calls", async () => {
    const repository = new FakeModelRepository();
    const calls = [];
    const service = new ModelService({
      repository,
      provider: {
        async create(input) {
          calls.push(input);
          return {
            providerReference: "resp_review",
            outputText: '{"status":"PASSED","feedback":[]}',
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 10,
          };
        },
      },
    });
    await service.call({
      runId: "run_test",
      tenantId: "tenant_test",
      agentName: "web-builder",
      purpose: "review",
      instructions: "Review this site.",
      input: "<html>site</html>",
      maxOutputTokens: 100,
      idempotencyKey: "site-review-v1",
    });
    assert.equal(calls[0].model, "gpt-5.6-terra");
    assert.equal(repository.reservations[0].modelTier, "terra");
  });

  test("returns a completed idempotent replay without another provider call", async () => {
    let providerCalls = 0;
    const replay = {
      callId: "call_existing",
      model: "gpt-5.6-sol",
      outputText: '{"completed":true}',
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costMicrodollars: 200,
      },
      replayed: true,
    };
    const service = new ModelService({
      repository: {
        async reserveAgentCall() {
          return { replayed: true, result: replay };
        },
      },
      provider: {
        async create() {
          providerCalls += 1;
        },
      },
    });

    const result = await service.call({
      runId: "run_test",
      tenantId: "tenant_test",
      agentName: "strategist",
      instructions: "Plan.",
      input: "Brief.",
      maxOutputTokens: 100,
      idempotencyKey: "strategist-plan-v1",
    });

    assert.deepEqual(result, replay);
    assert.equal(providerCalls, 0);
  });
});
