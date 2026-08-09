import Stripe from "stripe";
import { ValidationError } from "../../shared/errors.js";

export class StripeSandboxProvider {
  constructor({ secretKey, webhookSecret, client } = {}) {
    if (!client && !secretKey?.startsWith("sk_test_")) {
      throw new ValidationError("STRIPE_SANDBOX_SECRET_KEY must be a Stripe test key");
    }
    this.client = client ?? new Stripe(secretKey);
    this.webhookSecret = webhookSecret;
    this.mode = "TEST";
  }

  async createCheckoutSession({
    reservationId,
    tenantId,
    customerEmail,
    currency,
    lineItems,
    successUrl,
    cancelUrl,
    expiresAt,
    idempotencyKey,
  }) {
    const session = await this.client.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: customerEmail,
        line_items: lineItems.map((item) => ({
          quantity: item.quantity,
          price_data: {
            currency,
            unit_amount: item.unitAmountCents,
            product_data: {
              name: item.name,
              description: item.description,
            },
          },
        })),
        success_url: successUrl,
        cancel_url: cancelUrl,
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        metadata: {
          reservation_id: reservationId,
          tenant_id: tenantId,
        },
        payment_intent_data: {
          metadata: {
            reservation_id: reservationId,
            tenant_id: tenantId,
          },
        },
      },
      { idempotencyKey },
    );
    return {
      id: session.id,
      url: session.url,
      amountTotal: session.amount_total,
      currency: session.currency,
      expiresAt: session.expires_at,
      livemode: session.livemode,
    };
  }

  constructWebhookEvent(rawBody, signature) {
    if (!this.webhookSecret) {
      throw new ValidationError("STRIPE_WEBHOOK_SECRET is not configured");
    }
    if (!signature) throw new ValidationError("Stripe-Signature is required");
    return this.client.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
  }
}
