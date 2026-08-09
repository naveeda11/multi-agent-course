export class Ops {
  constructor({ gateClient }) {
    this.gateClient = gateClient;
  }

  async finalizeRun(input) {
    return this.gateClient.finalizeRun(input);
  }

  async persistCatalog(input) {
    return this.gateClient.persistCatalog(input);
  }

  async createCheckoutSession(input) {
    return this.gateClient.createCheckoutSession(input);
  }

  async processStripeWebhook(input) {
    return this.gateClient.processStripeWebhook(input);
  }

  async readOrderStatus(reservationId, siteOrigin) {
    return this.gateClient.readOrderStatus(reservationId, siteOrigin);
  }
}
