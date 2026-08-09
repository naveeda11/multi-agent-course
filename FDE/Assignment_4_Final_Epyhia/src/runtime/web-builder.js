import { ValidationError } from "../shared/errors.js";

const SITE_SCHEMA = {
  name: "epyhia_site",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["html"],
    properties: { html: { type: "string", minLength: 500 } },
  },
};

const REVIEW_SCHEMA = {
  name: "epyhia_site_review",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "feedback"],
    properties: {
      status: { type: "string", enum: ["PASSED", "FAILED"] },
      feedback: { type: "array", items: { type: "string" }, maxItems: 20 },
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

function addRecoveredColorSchemePreference(html) {
  if (/prefers-color-scheme/i.test(html)) return html;
  const styleEnd = html.toLowerCase().lastIndexOf("</style>");
  if (styleEnd === -1) {
    throw new ValidationError("Recovered Website draft has no style block");
  }
  const preference =
    "@media (prefers-color-scheme: dark){:root:not([data-theme]){color-scheme:dark}}";
  return `${html.slice(0, styleEnd)}${preference}${html.slice(styleEnd)}`;
}

export class WebBuilder {
  constructor({ gateClient, publicApiBaseUrl, maxDrafts = 3 }) {
    this.gateClient = gateClient;
    this.publicApiBaseUrl = new URL(publicApiBaseUrl).origin;
    this.maxDrafts = maxDrafts;
  }

  async buildAndRequestDeploy({
    tenantId,
    runId,
    idempotencyKey,
    revisionFeedback = [],
  }) {
    const context = await this.gateClient.readRunContext({ tenantId, runId });
    const taskId = context.tasks.find((task) => task.taskType === "WEB_BUILD")?.id;
    let feedback = [...revisionFeedback];
    for (let revision = 1; revision <= this.maxDrafts; revision += 1) {
      const draftCall = await this.gateClient.modelCall({
        tenantId,
        runId,
        taskId,
        instructions: [
          "You are EPYHIA's Web Builder. Return one complete standalone index.html with embedded CSS and JavaScript.",
          "Build a polished, trust-first local rental landing page for families and small-business event buyers.",
          "Use a light default theme with a real dark-mode token system, an asymmetric context-driven layout, responsive design,",
          "subtle motion, and prefers-reduced-motion support. Avoid generic AI-purple styling and three equal feature cards.",
          "Keep the complete HTML under 35,000 characters. Prefer concise CSS and JavaScript so the structured JSON response always closes.",
          "Keep the hero headline to two lines and its supporting copy to 20 words. Include at least one relevant direct HTTPS image",
          "from images.unsplash.com with meaningful alt text; use it only as clearly illustrative event atmosphere, never as",
          "the business's actual inventory or evidence of the exact rented equipment. Tier 3 rejects other image hosts and broken/non-image responses.",
          "Use img src only, not srcset or picture source candidates, so Tier 3 can verify every loaded image.",
          "Do not add a Content Security Policy; Tier 3 injects the exact outbound allow-list after validation.",
          "Never invent testimonials, reviews, prices, inventory, capabilities, guarantees, or contact details.",
          "Do not use em dashes, lorem ipsum, TODO, or TBD. Include every catalog item, exact item id, decimal price, uppercase currency code, and available quantity.",
          `The checkout form must collect customer name/email, start/end dates, and quantities, then POST JSON to ${this.publicApiBaseUrl}/api/checkout`,
          "The checkout JSON body must be exactly shaped as { customer: { name, email }, startDate, endDate, items: [{ itemId, quantity }] }; do not send flat customerName/customerEmail fields.",
          "with a unique Idempotency-Key and redirect the browser to the returned Stripe Checkout URL.",
          `When checkout=success and reservation_id are present in the page URL, poll ${this.publicApiBaseUrl}/api/orders/{reservation_id}`,
          "Use location.search.includes('checkout=success') so the exact verified success marker is present in the HTML source.",
          "The order endpoint returns { reservationStatus, order: null | { status: 'PAID' } }.",
          "Only after response.order?.status === 'PAID', show the technical status 'Test order recorded as paid'.",
          "Do not claim that payment confirms the rental, inventory, fulfillment, delivery, or availability; the Stripe redirect alone is never proof.",
          "Treat the supplied completed brief, brand document, business fields, and catalog as the only factual sources.",
        ].join(" "),
        input: JSON.stringify({ context, revisionFeedback: feedback }),
        maxOutputTokens: 13_000,
        responseSchema: SITE_SCHEMA,
        idempotencyKey: `${idempotencyKey}:draft:v${revision}`,
      });
      const draft = parseJson(draftCall.outputText, "Web Builder draft");
      const reviewCall = await this.gateClient.modelCall({
        tenantId,
        runId,
        taskId,
        purpose: "review",
        instructions: [
          "Act as a strict source and UX reviewer for a standalone rental website.",
          "Fail if any concrete claim, catalog item, price, quantity, contact detail, or capability is unsupported by the context.",
          "Treat the supplied checkout/order API behavior as authoritative only for technical UI mechanics, never as a business fulfillment policy.",
          "Fail if checkout is not wired to the supplied public API with customer: { name, email }, startDate, endDate, and items: [{ itemId, quantity }], if mobile/responsive and accessibility safeguards are absent,",
          "or if the design uses filler, fake testimonials, generic three-card layout, unreadable hierarchy, or an oversized text-heavy hero.",
          "PASSED means the HTML source is grounded, complete, usable, and ready for deterministic Gate validation.",
        ].join(" "),
        input: JSON.stringify({ context, publicApiBaseUrl: this.publicApiBaseUrl, html: draft.html }),
        maxOutputTokens: 2_000,
        responseSchema: REVIEW_SCHEMA,
        idempotencyKey: `${idempotencyKey}:review:v${revision}`,
      });
      const review = parseJson(reviewCall.outputText, "Web Builder review");
      if (review.status === "PASSED") {
        const persisted = await this.gateClient.persistSiteArtifact({
          tenantId,
          runId,
          html: draft.html,
          publicApiBaseUrl: this.publicApiBaseUrl,
          review,
          revisionNumber: revision,
          idempotencyKey: `${idempotencyKey}:persist`,
        });
        const deployment = await this.gateClient.requestDeploy({
          tenantId,
          runId,
          mode: "LIVE",
          payload: { projectName: persisted.projectName, files: persisted.files },
          idempotencyKey: `${idempotencyKey}:deploy`,
        });
        return { draft, review, persisted, deployment, draftCall, reviewCall };
      }
      feedback = [...revisionFeedback, ...review.feedback];
    }
    throw new ValidationError("Website failed source and UX review three times");
  }

  async recoverReviewedBuild({ tenantId, runId, idempotencyKey }) {
    const recovered = await this.gateClient.recoverSiteArtifact({ tenantId, runId });
    const html = addRecoveredColorSchemePreference(recovered.draft.html);
    const persisted = await this.gateClient.persistSiteArtifact({
      tenantId,
      runId,
      html,
      publicApiBaseUrl: this.publicApiBaseUrl,
      review: recovered.review,
      revisionNumber: recovered.revisionNumber,
      idempotencyKey: `${idempotencyKey}:persist`,
    });
    const deployment = await this.gateClient.requestDeploy({
      tenantId,
      runId,
      mode: "LIVE",
      payload: { projectName: persisted.projectName, files: persisted.files },
      idempotencyKey: `${idempotencyKey}:deploy`,
    });
    return {
      draft: { html },
      review: recovered.review,
      persisted,
      deployment,
      recovered: true,
    };
  }
}
