import { ValidationError } from "../shared/errors.js";
import { assertGroundedCurrencyClaims } from "./price-grounding.js";

const CHANNELS = new Set(["instagram", "linkedin", "facebook", "x"]);
const FORBIDDEN_FILLER = /\b(lorem ipsum|todo|tbd|placeholder)\b/i;
const FORBIDDEN_SOCIAL_PROOF = /(?:testimonial|five[- ]star|customers love us)/i;
const VIDEO_DURATION = /\b(\d+)\s*(?:-|‑)?\s*seconds?\b/gi;
const REQUIRED_VIDEO_DURATION = /\b4\s*(?:-|‑)?\s*seconds?\b/i;

function requireText(value, name, max = 10_000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ValidationError(`${name} must contain between 1 and ${max} characters`);
  }
  if (FORBIDDEN_FILLER.test(value) || FORBIDDEN_SOCIAL_PROOF.test(value)) {
    throw new ValidationError(`${name} contains forbidden filler or social proof`);
  }
  return value.trim();
}

function requireReviewText(value, name, max = 2_000) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new ValidationError(`${name} must contain between 1 and ${max} characters`);
  }
  return value.trim();
}

function requireFourSecondPrompt(value, name) {
  const prompt = requireText(value, name, 10_000);
  const durations = [...prompt.matchAll(VIDEO_DURATION)].map((match) => Number(match[1]));
  if (!REQUIRED_VIDEO_DURATION.test(prompt) || durations.some((duration) => duration !== 4)) {
    throw new ValidationError(`${name} must request exactly a 4-second video`);
  }
  return prompt;
}

export class MarketingService {
  constructor({ repository }) {
    this.repository = repository;
  }

  async persistPack({
    tenantId,
    runId,
    pack,
    review,
    idempotencyKey,
    agentName = "marketer",
  }) {
    if (review?.status !== "PASSED") {
      throw new ValidationError("Marketing pack grounding review must pass before persistence");
    }
    const landingCopy = requireText(pack?.landingCopy, "landingCopy", 30_000);
    if (!Array.isArray(pack?.socialPosts) || pack.socialPosts.length < 3 || pack.socialPosts.length > 5) {
      throw new ValidationError("Marketing pack must contain between 3 and 5 social posts");
    }
    const socialPosts = pack.socialPosts.map((post, index) => {
      const channel = post?.channel?.toLowerCase();
      if (!CHANNELS.has(channel)) {
        throw new ValidationError(`socialPosts[${index}].channel is unsupported`);
      }
      return { channel, text: requireText(post.text, `socialPosts[${index}].text`, 5_000) };
    });
    const launchEmail = requireText(pack.launchEmail, "launchEmail", 30_000);
    const storyboard = {
      summary: requireText(pack.storyboard?.summary, "storyboard.summary", 30_000),
      landscapePrompt: requireFourSecondPrompt(
        pack.storyboard?.landscapePrompt,
        "storyboard.landscapePrompt",
      ),
      verticalPrompt: requireFourSecondPrompt(
        pack.storyboard?.verticalPrompt,
        "storyboard.verticalPrompt",
      ),
    };
    const normalizedReview = {
      status: "PASSED",
      feedback: Array.isArray(review.feedback)
        ? review.feedback.map((entry) => requireReviewText(entry, "review.feedback"))
        : [],
      checkedClaims: Array.isArray(review.checkedClaims)
        ? review.checkedClaims.map((entry) => requireReviewText(entry, "review.checkedClaims"))
        : [],
    };
    if (normalizedReview.checkedClaims.length === 0) {
      throw new ValidationError("Marketing review must identify at least one checked claim");
    }
    const context = await this.repository.readRunContext({ tenantId, runId });
    assertGroundedCurrencyClaims(
      [
        landingCopy,
        ...socialPosts.map((post) => post.text),
        launchEmail,
        storyboard.summary,
        storyboard.landscapePrompt,
        storyboard.verticalPrompt,
      ].join("\n"),
      context.catalog,
      "Marketing pack",
    );
    return this.repository.persistMarketingPack({
      tenantId,
      runId,
      pack: { landingCopy, socialPosts, launchEmail, storyboard },
      review: normalizedReview,
      idempotencyKey,
      agentName,
    });
  }

  async approvePack(input) {
    requireText(input.tenantId, "tenantId", 200);
    requireText(input.runId, "runId", 200);
    requireText(input.approvedBy, "approvedBy", 500);
    requireText(input.idempotencyKey, "idempotencyKey", 200);
    if (!/^[a-f0-9]{64}$/.test(input.packHash ?? "")) {
      throw new ValidationError("packHash must be a SHA-256 hex digest");
    }
    return this.repository.approveMarketingPack(input);
  }
}
