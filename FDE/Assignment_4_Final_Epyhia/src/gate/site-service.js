import { ValidationError } from "../shared/errors.js";
import { assertGroundedCurrencyClaims } from "./price-grounding.js";

const FORBIDDEN = [
  /lorem ipsum/i,
  /\bTODO\b/i,
  /\bTBD\b/i,
  /—|–/,
  /(?:testimonial|five[- ]star|customers love us)/i,
];

function normalizePhone(value) {
  return String(value).replace(/[^+\d]/g, "");
}

function validateStandaloneReferences(html, business) {
  const forbiddenMarkup = [
    /<script\b[^>]*\bsrc\s*=/i,
    /<link\b[^>]*\brel\s*=\s*["']?stylesheet\b/i,
    /<(?:iframe|object|embed|base)\b/i,
    /<form\b[^>]*\baction\s*=/i,
    /@import\b/i,
    /url\(\s*["']?https?:/i,
  ];
  if (forbiddenMarkup.some((pattern) => pattern.test(html))) {
    throw new ValidationError(
      "Generated site must keep executable, style, and embedded resources standalone",
    );
  }

  const ids = new Set(
    [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
  );
  const links = [
    ...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi),
  ].map((match) => match[1].trim());
  for (const href of links) {
    if (href === "#" || href === "/" || /^\/(?:[?#].*)?$/.test(href)) continue;
    if (href.startsWith("#")) {
      if (!ids.has(href.slice(1))) {
        throw new ValidationError("Generated site contains a broken fragment link");
      }
      continue;
    }
    if (href.toLowerCase().startsWith("mailto:")) {
      let target;
      try {
        target = decodeURIComponent(href.slice(7).split("?", 1)[0]).toLowerCase();
      } catch {
        throw new ValidationError("Generated site contains an invalid email link");
      }
      if (target === business.email.toLowerCase()) continue;
    }
    if (href.toLowerCase().startsWith("tel:")) {
      if (normalizePhone(href.slice(4)) === normalizePhone(business.phone)) continue;
    }
    throw new ValidationError("Generated site contains an unsupported or ungrounded link");
  }
}

function addContentSecurityPolicy(html, apiUrl, allowedImageHosts) {
  if (/<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/i.test(html)) {
    throw new ValidationError("Generated site must leave Content Security Policy to Tier 3");
  }
  const head = /<head\b[^>]*>/i.exec(html);
  if (!head) throw new ValidationError("Generated site must contain a head element");
  const imageSources = ["'self'", ...allowedImageHosts].join(" ");
  const policy = [
    "default-src 'self'",
    `img-src ${imageSources}`,
    `connect-src ${apiUrl}`,
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  return `${html.slice(0, head.index + head[0].length)}${meta}${html.slice(head.index + head[0].length)}`;
}

export class SiteService {
  constructor({
    repository,
    fetchImpl = fetch,
    allowedImageHosts = ["images.unsplash.com"],
  }) {
    this.repository = repository;
    this.fetch = fetchImpl;
    this.allowedImageHosts = new Set(allowedImageHosts);
  }

  async persist({
    tenantId,
    runId,
    html,
    publicApiBaseUrl,
    review,
    revisionNumber,
    idempotencyKey,
    agentName = "web-builder",
  }) {
    if (typeof html !== "string" || html.length < 500 || html.length > 1_000_000) {
      throw new ValidationError("Generated site HTML must contain 500 to 1,000,000 characters");
    }
    if (review?.status !== "PASSED") {
      throw new ValidationError("Site review must pass before persistence");
    }
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1 || revisionNumber > 3) {
      throw new ValidationError("Site revisionNumber must be an integer between 1 and 3");
    }
    let apiUrl;
    try {
      apiUrl = new URL(publicApiBaseUrl).origin;
    } catch {
      throw new ValidationError("publicApiBaseUrl must be an absolute URL");
    }
    const context = await this.repository.readRunContext({ tenantId, runId });
    const htmlLower = html.toLowerCase();
    const requiredFragments = [
      "<!doctype html",
      'name="viewport"',
      "prefers-color-scheme",
      "prefers-reduced-motion",
      "/api/checkout",
      "/api/orders/",
      "checkout=success",
      "reservation_id",
      apiUrl.toLowerCase(),
      context.business.name.toLowerCase(),
      context.business.email.toLowerCase(),
      context.business.phone.toLowerCase(),
      context.business.address.toLowerCase(),
    ];
    for (const item of context.catalog) {
      requiredFragments.push(item.name.toLowerCase());
      requiredFragments.push((item.dayRateCents / 100).toFixed(2));
      requiredFragments.push(item.currency.toLowerCase());
      requiredFragments.push(item.id.toLowerCase());
    }
    const missing = requiredFragments.filter((fragment) => !htmlLower.includes(fragment));
    if (missing.length > 0) {
      throw new ValidationError("Generated site is missing grounded checkout or brand content", {
        missing,
      });
    }
    const customerObject = /\bcustomer\s*:\s*\{([\s\S]{0,800}?)\}/i.exec(html)?.[1] ?? "";
    if (!/\bname\s*:/.test(customerObject) || !/\bemail\s*:/.test(customerObject)) {
      throw new ValidationError(
        "Generated site checkout must send customer: { name, email }",
      );
    }
    for (const pattern of FORBIDDEN) {
      if (pattern.test(html)) {
        throw new ValidationError(`Generated site contains forbidden pattern ${pattern}`);
      }
    }
    validateStandaloneReferences(html, context.business);
    const claimBearingHtml = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    assertGroundedCurrencyClaims(claimBearingHtml, context.catalog, "Generated site");
    if (!/<img\b[^>]*\balt=["'][^"']+["']/i.test(html)) {
      throw new ValidationError("Generated site needs at least one meaningful image with alt text");
    }
    if (/\bsrcset\s*=/i.test(html)) {
      throw new ValidationError("Generated site must use only verified img src URLs");
    }
    const imageSources = [
      ...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
    ].map((match) => match[1]);
    if (imageSources.length === 0) {
      throw new ValidationError("Generated site needs at least one remote image source");
    }
    for (const source of imageSources) {
      let imageUrl;
      try {
        imageUrl = new URL(source);
      } catch {
        throw new ValidationError("Generated site contains an invalid image URL");
      }
      if (
        imageUrl.protocol !== "https:" ||
        !this.allowedImageHosts.has(imageUrl.hostname.toLowerCase())
      ) {
        throw new ValidationError("Generated site image host is not allow-listed");
      }
      let imageResponse;
      try {
        imageResponse = await this.fetch(imageUrl, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        throw new ValidationError("Generated site image could not be verified");
      }
      const contentType = imageResponse.headers.get("content-type") ?? "";
      if (!imageResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
        throw new ValidationError("Generated site image did not return a valid image response");
      }
      await imageResponse.body?.cancel();
    }
    const readsOrderObject = /(?:\.order\b|\[['"]order['"]\])/i.test(html);
    const readsOrderStatus = /(?:\.status\b|\[['"]status['"]\])/i.test(html);
    const checksPaid = /['"]PAID['"]/i.test(html);
    if (!readsOrderObject || !readsOrderStatus || !checksPaid) {
      throw new ValidationError(
        "Generated site must confirm checkout only from the persisted PAID order response",
      );
    }
    const hardenedHtml = addContentSecurityPolicy(
      html,
      apiUrl,
      [...this.allowedImageHosts].map((host) => `https://${host}`),
    );
    if (hardenedHtml.length > 1_000_000) {
      throw new ValidationError("Generated site exceeds 1,000,000 characters after hardening");
    }
    return this.repository.persistSiteArtifact({
      tenantId,
      runId,
      html: hardenedHtml,
      publicApiBaseUrl: apiUrl,
      review,
      revisionNumber,
      idempotencyKey,
      agentName,
    });
  }
}
