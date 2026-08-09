import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAIResponsesProvider } from "../src/gate/providers/openai-responses.js";

test("OpenAI Responses receives the durable Gate idempotency key", async () => {
  const calls = [];
  const provider = new OpenAIResponsesProvider({
    client: {
      responses: {
        async create(body, options) {
          calls.push({ body, options });
          return {
            id: "resp_test",
            output_text: "done",
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 4,
            },
          };
        },
      },
    },
  });
  const result = await provider.create({
    idempotencyKey: "epyhia-call_test",
    model: "gpt-5.6-luna",
    instructions: "Return a deterministic test response.",
    input: "test",
    maxOutputTokens: 20,
    reasoningEffort: "low",
    safetyIdentifier: "0".repeat(64),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.idempotencyKey, "epyhia-call_test");
  assert.equal(calls[0].body.store, false);
  assert.equal(result.providerReference, "resp_test");
});
