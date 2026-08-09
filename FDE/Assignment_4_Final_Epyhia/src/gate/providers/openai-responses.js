import OpenAI from "openai";

export class OpenAIResponsesProvider {
  constructor({ apiKey, client } = {}) {
    this.client = client ?? new OpenAI({ apiKey });
  }

  async create({
    idempotencyKey,
    model,
    instructions,
    input,
    maxOutputTokens,
    reasoningEffort,
    responseSchema,
    safetyIdentifier,
  }) {
    const response = await this.client.responses.create(
      {
        model,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        reasoning: { effort: reasoningEffort },
        text: responseSchema
          ? {
              format: {
                type: "json_schema",
                name: responseSchema.name,
                strict: true,
                schema: responseSchema.schema,
              },
            }
          : undefined,
        safety_identifier: safetyIdentifier,
        store: false,
      },
      { idempotencyKey },
    );
    return {
      providerReference: response.id,
      outputText: response.output_text,
      inputTokens: response.usage?.input_tokens ?? 0,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  }
}
