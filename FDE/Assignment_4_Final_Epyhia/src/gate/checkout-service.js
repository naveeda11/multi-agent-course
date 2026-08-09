import { payloadHash, sha256 } from "../shared/canonical.js";
import {
  ConflictError,
  ProviderError,
  ValidationError,
} from "../shared/errors.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RENTAL_DAYS = 365;

function validateText(value, name, { min = 1, max = 300 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ValidationError(`${name} must contain between ${min} and ${max} characters`);
  }
}

function validateReturnUrl(value, siteOrigin, name) {
  let url;
  let origin;
  try {
    url = new URL(value);
    origin = new URL(siteOrigin);
  } catch {
    throw new ValidationError(`${name} and siteOrigin must be absolute URLs`);
  }
  if (url.origin !== origin.origin) {
    throw new ValidationError(`${name} must use the requesting site's origin`);
  }
  const localDevelopment = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (origin.protocol !== "https:" && !(localDevelopment && origin.protocol === "http:")) {
    throw new ValidationError("Checkout return URLs require HTTPS outside local development");
  }
  return url.toString();
}

function validateCheckout(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Checkout input must be an object");
  }
  validateText(input.siteOrigin, "siteOrigin", { max: 500 });
  validateText(input.idempotencyKey, "idempotencyKey", { min: 3, max: 200 });
  validateText(input.customer?.name, "customer.name", { max: 200 });
  validateText(input.customer?.email, "customer.email", { max: 320 });
  if (!EMAIL_PATTERN.test(input.customer.email)) {
    throw new ValidationError("customer.email must be a valid email address");
  }
  if (!DATE_PATTERN.test(input.startDate ?? "") || !DATE_PATTERN.test(input.endDate ?? "")) {
    throw new ValidationError("startDate and endDate must use YYYY-MM-DD");
  }
  const start = Date.parse(`${input.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${input.endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new ValidationError("endDate must be after startDate");
  }
  const rentalDays = (end - start) / 86_400_000;
  if (!Number.isInteger(rentalDays) || rentalDays > MAX_RENTAL_DAYS) {
    throw new ValidationError(
      `Rental periods must contain between 1 and ${MAX_RENTAL_DAYS} days`,
    );
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
    throw new ValidationError("items must contain between 1 and 20 selections");
  }
  const itemIds = new Set();
  for (const item of input.items) {
    validateText(item?.itemId, "items.itemId", { min: 3, max: 200 });
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1_000) {
      throw new ValidationError("Each item quantity must be an integer between 1 and 1,000");
    }
    if (itemIds.has(item.itemId)) {
      throw new ValidationError("Duplicate rental item selections are not allowed");
    }
    itemIds.add(item.itemId);
  }
  return {
    ...input,
    successUrl: validateReturnUrl(input.successUrl, input.siteOrigin, "successUrl"),
    cancelUrl: validateReturnUrl(input.cancelUrl, input.siteOrigin, "cancelUrl"),
  };
}

export class CheckoutService {
  constructor({ repository, provider, now = () => new Date() }) {
    this.repository = repository;
    this.provider = provider;
    this.now = now;
  }

  async createSession(input) {
    const validated = validateCheckout(input);
    const auditPayload = {
      siteOrigin: validated.siteOrigin,
      customerEmailHash: sha256(validated.customer.email.trim().toLowerCase()),
      startDate: validated.startDate,
      endDate: validated.endDate,
      items: validated.items,
      successUrl: validated.successUrl,
      cancelUrl: validated.cancelUrl,
    };
    const reservation = await this.repository.createCheckoutReservation({
      ...validated,
      actionPayloadHash: payloadHash(auditPayload),
      auditPayload,
    });
    if (reservation.checkoutUrl) {
      return {
        reservationId: reservation.reservationId,
        checkoutSessionId: reservation.checkoutSessionId,
        checkoutUrl: reservation.checkoutUrl,
        totalCents: reservation.totalCents,
        currency: reservation.currency,
        replayed: true,
      };
    }

    const expiresAt = new Date(this.now().getTime() + 60 * 60 * 1000);
    try {
      const successUrl = new URL(validated.successUrl);
      successUrl.searchParams.set("reservation_id", reservation.reservationId);
      const session = await this.provider.createCheckoutSession({
        reservationId: reservation.reservationId,
        tenantId: reservation.tenantId,
        customerEmail: validated.customer.email.trim(),
        currency: reservation.currency,
        lineItems: reservation.lineItems,
        successUrl: successUrl.toString(),
        cancelUrl: validated.cancelUrl,
        expiresAt,
        idempotencyKey: `checkout:${reservation.reservationId}`,
      });
      if (session.livemode !== false) {
        throw new ConflictError("The Action Gate refuses live-mode Stripe sessions");
      }
      let checkoutUrl;
      try {
        checkoutUrl = new URL(session.url);
      } catch {
        throw new ConflictError("Stripe returned an invalid Checkout Session URL");
      }
      if (
        !/^cs_test_[A-Za-z0-9_]+$/.test(session.id ?? "") ||
        checkoutUrl.protocol !== "https:" ||
        checkoutUrl.hostname !== "checkout.stripe.com"
      ) {
        throw new ConflictError("Stripe returned a non-test Checkout Session identity");
      }
      if (
        session.amountTotal !== reservation.totalCents ||
        session.currency?.toLowerCase() !== reservation.currency
      ) {
        throw new ConflictError("Stripe session amount or currency does not match reservation");
      }
      await this.repository.completeCheckoutSession({
        reservationId: reservation.reservationId,
        actionId: reservation.actionId,
        checkoutSessionId: session.id,
        checkoutUrl: checkoutUrl.toString(),
        expiresAt: new Date(session.expiresAt * 1000),
      });
      return {
        reservationId: reservation.reservationId,
        checkoutSessionId: session.id,
        checkoutUrl: checkoutUrl.toString(),
        totalCents: reservation.totalCents,
        currency: reservation.currency,
        replayed: false,
      };
    } catch (error) {
      await this.repository.failAction(reservation.actionId, error.message);
      if (error instanceof ValidationError || error instanceof ConflictError) throw error;
      throw new ProviderError("Stripe sandbox Checkout Session creation failed", {
        cause: error.message,
      });
    }
  }

  async processWebhook({ rawBody, signature }) {
    let event;
    try {
      event = this.provider.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      throw new ValidationError("Stripe webhook signature verification failed", {
        cause: error.message,
      });
    }
    if (event.livemode !== false) {
      throw new ValidationError("Live-mode Stripe events are not accepted");
    }
    if (![
      "checkout.session.completed",
      "checkout.session.expired",
    ].includes(event.type)) {
      return { eventId: event.id, ignored: true, replayed: false };
    }
    return this.repository.processStripeWebhook({ event });
  }

  async readOrderStatus({ reservationId, siteOrigin }) {
    validateText(reservationId, "reservationId", { min: 3, max: 200 });
    validateText(siteOrigin, "siteOrigin", { min: 8, max: 500 });
    let host;
    try {
      host = new URL(siteOrigin).host.toLowerCase();
    } catch {
      throw new ValidationError("siteOrigin must be an absolute URL");
    }
    return this.repository.readOrderStatus(reservationId, host);
  }
}
