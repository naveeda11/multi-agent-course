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

  async eraseCheckoutSessions(sessionIds) {
    const results = [];
    for (const sessionId of [...new Set(sessionIds.filter(Boolean))]) {
      let session;
      try {
        session = await this.client.checkout.sessions.retrieve(sessionId, {
          expand: ["customer", "payment_intent.latest_charge"],
        });
      } catch (error) {
        if (error?.code === "resource_missing" || error?.statusCode === 404) {
          results.push({ sessionId, alreadyDeleted: true });
          continue;
        }
        throw error;
      }
      if (session.livemode) {
        throw new ValidationError("Tenant erasure cannot modify live Stripe objects");
      }
      if (session.status === "open") {
        await this.client.checkout.sessions.expire(sessionId);
      }
      await this.client.checkout.sessions.update(sessionId, {
        metadata: { reservation_id: "", tenant_id: "" },
      });

      let paymentIntent = session.payment_intent;
      if (typeof paymentIntent === "string") {
        paymentIntent = await this.client.paymentIntents.retrieve(paymentIntent, {
          expand: ["latest_charge"],
        });
      }
      if (paymentIntent) {
        await this.client.paymentIntents.update(paymentIntent.id, {
          metadata: { reservation_id: "", tenant_id: "" },
        });
        const charge = paymentIntent.latest_charge;
        if (charge && typeof charge !== "string") {
          await this.client.charges.update(charge.id, {
            metadata: { reservation_id: "", tenant_id: "" },
          });
        }
      }

      const customer = session.customer;
      if (customer) {
        try {
          await this.client.customers.del(
            typeof customer === "string" ? customer : customer.id,
          );
        } catch (error) {
          if (error?.code !== "resource_missing" && error?.statusCode !== 404) throw error;
        }
      }
      results.push({
        sessionId,
        expired: session.status === "open",
        identifyingMetadataRemoved: true,
        customerDeleted: Boolean(customer),
      });
    }
    return {
      sessions: results,
      providerRetentionNotice:
        "Stripe does not expose hard deletion for completed Checkout Sessions, PaymentIntents, or Charges; EPYHIA removed its metadata and deleted any Customer objects.",
    };
  }
}
