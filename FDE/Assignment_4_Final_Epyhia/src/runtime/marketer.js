import { ValidationError } from "../shared/errors.js";

const PACK_SCHEMA = {
  name: "epyhia_marketing_pack",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["landingCopy", "socialPosts", "launchEmail", "storyboard"],
    properties: {
      landingCopy: { type: "string", minLength: 1 },
      socialPosts: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["channel", "text"],
          properties: {
            channel: {
              type: "string",
              enum: ["instagram", "linkedin", "facebook", "x"],
            },
            text: { type: "string", minLength: 1 },
          },
        },
      },
      launchEmail: { type: "string", minLength: 1 },
      storyboard: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "landscapePrompt", "verticalPrompt"],
        properties: {
          summary: { type: "string", minLength: 1 },
          landscapePrompt: { type: "string", minLength: 1 },
          verticalPrompt: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const REVIEW_SCHEMA = {
  name: "epyhia_marketing_review",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "feedback", "checkedClaims"],
    properties: {
      status: { type: "string", enum: ["PASSED", "FAILED"] },
      feedback: { type: "array", items: { type: "string" }, maxItems: 20 },
      checkedClaims: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
        maxItems: 50,
      },
    },
  },
};

function parseJson(outputText, label) {
  try {
    return JSON.parse(outputText);
  } catch {
    throw new ValidationError(`${label} returned invalid JSON`);
  }
}

export class Marketer {
  constructor({ gateClient, maxDrafts = 2 }) {
    this.gateClient = gateClient;
    this.maxDrafts = maxDrafts;
  }

  async createAndPersistPack({ tenantId, runId, idempotencyKey }) {
    const context = await this.gateClient.readRunContext({ tenantId, runId });
    let feedback = [];
    for (let revision = 1; revision <= this.maxDrafts; revision += 1) {
      const draftCall = await this.gateClient.modelCall({
        tenantId,
        runId,
        taskId: context.tasks.find((task) => task.taskType === "MARKETING_PACK")?.id,
        instructions: [
          "You are EPYHIA's Marketer. Produce a launch pack strictly grounded in the supplied",
          "completed brief, brand document, tenant contact details, and catalog.",
          "Name the persisted business and reference at least one real catalog item across the pack.",
          "Do not invent prices, inventory, features, testimonials, reviews, guarantees,",
          "delivery promises, or social proof. Landing copy must include a clear CTA.",
          "Whenever copy mentions a price, use the exact decimal day rate and uppercase catalog currency code.",
          "The launch email is a draft only and must not claim it was sent.",
          "The storyboard must describe exactly two 4-second moving videos: one 16:9 launch video and one 9:16 cut.",
          "and provide separate cinematic Veo prompts using one camera movement, one primary action,",
          "grounded context, and brand lighting. Depict a generic illustrative example of a catalog item, never the business's",
          "actual or verified inventory. Use a neutral setting with no claimed filming, storage, or business-premises location.",
          "Describe condition only as well-maintained; do not infer cleanliness, construction, materials, setup, delivery, or handling.",
          "Veo prompts must request no text, logos, UI, or audio.",
        ].join(" "),
        input: JSON.stringify({ context, revisionFeedback: feedback }),
        maxOutputTokens: 6_000,
        responseSchema: PACK_SCHEMA,
        idempotencyKey: `${idempotencyKey}:draft:v${revision}`,
      });
      const pack = parseJson(draftCall.outputText, "Marketer draft");
      const reviewCall = await this.gateClient.modelCall({
        tenantId,
        runId,
        taskId: context.tasks.find((task) => task.taskType === "MARKETING_PACK")?.id,
        instructions: [
          "Act as a strict factual-grounding reviewer.",
          "Compare every concrete claim, price, contact detail, availability statement,",
          "feature, and promise in the marketing pack to the supplied source context.",
          "Write every mentioned price as an exact decimal plus its uppercase catalog currency code.",
          "Fail on invented testimonials, social proof, prices, guarantees, or capabilities.",
          "Fail unless both video prompts explicitly request exactly 4 seconds; fail any other stated video duration.",
          "PASSED means every checked claim is supported by the source context.",
        ].join(" "),
        input: JSON.stringify({ context, pack }),
        maxOutputTokens: 2_000,
        responseSchema: REVIEW_SCHEMA,
        idempotencyKey: `${idempotencyKey}:review:v${revision}`,
      });
      const review = parseJson(reviewCall.outputText, "Marketing review");
      if (review.status === "PASSED") {
        const persisted = await this.gateClient.persistMarketingPack({
          tenantId,
          runId,
          pack,
          review,
          idempotencyKey: `${idempotencyKey}:persist`,
        });
        return { pack, review, persisted, draftCall, reviewCall };
      }
      feedback = review.feedback;
    }
    throw new ValidationError("Marketing pack failed grounding review twice");
  }
}
