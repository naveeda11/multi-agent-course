import { ValidationError } from "../shared/errors.js";

const STRATEGIST_SCHEMA = {
  name: "epyhia_strategy",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "clarificationQuestions",
      "completedBrief",
      "brandDocument",
      "catalog",
      "taskPlan",
    ],
    properties: {
      status: { type: "string", enum: ["NEEDS_CLARIFICATION", "READY"] },
      clarificationQuestions: {
        type: "array",
        maxItems: 8,
        items: { type: "string", minLength: 1 },
      },
      completedBrief: { type: "string" },
      brandDocument: { type: "string" },
      catalog: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "itemKey",
            "name",
            "description",
            "availableQuantity",
            "dayRateCents",
            "currency",
          ],
          properties: {
            itemKey: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
            name: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            availableQuantity: { type: "integer", minimum: 1 },
            dayRateCents: { type: "integer", minimum: 1 },
            currency: { type: "string", pattern: "^[a-z]{3}$" },
          },
        },
      },
      taskPlan: {
        type: "array",
        minItems: 0,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["taskType"],
          properties: {
            taskType: {
              type: "string",
              enum: ["CATALOG_PERSIST", "WEB_BUILD", "MARKETING_PACK"],
            },
          },
        },
      },
    },
  },
};

function parseStrategy(outputText) {
  let result;
  try {
    result = JSON.parse(outputText);
  } catch {
    throw new ValidationError("Strategist returned invalid JSON");
  }
  if (
    !["NEEDS_CLARIFICATION", "READY"].includes(result.status) ||
    !Array.isArray(result.clarificationQuestions) ||
    typeof result.completedBrief !== "string" ||
    typeof result.brandDocument !== "string" ||
    !Array.isArray(result.catalog) ||
    !Array.isArray(result.taskPlan)
  ) {
    throw new ValidationError("Strategist response is missing required outputs");
  }
  if (result.status === "NEEDS_CLARIFICATION") {
    if (result.clarificationQuestions.length === 0) {
      throw new ValidationError("Strategist requested clarification without questions");
    }
    if (
      result.completedBrief.length > 0 ||
      result.brandDocument.length > 0 ||
      result.catalog.length > 0 ||
      result.taskPlan.length > 0
    ) {
      throw new ValidationError(
        "A clarification response must not contain premature finalized outputs",
      );
    }
  } else if (
    result.clarificationQuestions.length > 0 ||
    result.completedBrief.length === 0 ||
    result.brandDocument.length === 0 ||
    result.catalog.length === 0 ||
    result.taskPlan.length !== 3
  ) {
    throw new ValidationError("A READY strategy must contain grounded outputs and no questions");
  }
  return result;
}

export class Strategist {
  constructor({ modelGateway }) {
    this.modelGateway = modelGateway;
  }

  async createBusinessPlan({
    tenantId,
    runId,
    tenant,
    originalBrief,
    clarificationAnswers = [],
    idempotencyKey,
  }) {
    const response = await this.modelGateway.modelCall({
      tenantId,
      runId,
      instructions: [
        "You are EPYHIA's Strategist.",
        "Complete the provided party-rental business brief without inventing prices,",
        "features, testimonials, or contact details.",
        "If required facts such as catalog quantities, day rates, currency, or contact details",
        "are missing from both the authoritative tenant fields and the brief, return NEEDS_CLARIFICATION with concise questions; leave grounded outputs",
        "empty and do not guess. Return READY only when the brief contains every catalog fact.",
        "Treat the supplied tenant business name, email, phone, address, and URL slug as authoritative; flag contradictions for clarification.",
        "When READY, produce a detailed brand document with Business Story, Mission, Strengths, Target Demographic, Logo Usage, Typography, Writing Tone and Grammar, Color Palette, Imagery Dos and Don'ts, Social Layout Guidance, and Contact Details sections; then produce the structured catalog in integer cents,",
        "and exactly three delegated task records.",
        "Do not call external systems and do not claim that work is deployed.",
      ].join(" "),
      input: JSON.stringify({ tenant, originalBrief, clarificationAnswers }),
      maxOutputTokens: 6_000,
      responseSchema: STRATEGIST_SCHEMA,
      idempotencyKey,
    });
    return { ...parseStrategy(response.outputText), modelCall: response };
  }
}
