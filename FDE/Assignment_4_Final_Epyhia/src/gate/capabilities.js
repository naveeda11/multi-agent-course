import {
  AuthenticationError,
  AuthorizationError,
  ValidationError,
} from "../shared/errors.js";

export const ACTIONS = Object.freeze({
  DEPLOY: "deploy",
  APPROVE: "approve",
  READ_AUDIT: "read-audit",
  READ_RUN_AUDIT: "read-run-audit",
  READ_TENANT_PROFILE: "read-tenant-profile",
  CREATE_RUN_SHELL: "create-run-shell",
  FINALIZE_RUN: "finalize-run",
  MODEL_CALL: "model-call",
  CREATE_CHECKOUT_SESSION: "checkout-session",
  PROCESS_STRIPE_WEBHOOK: "process-stripe-webhook",
  PERSIST_CATALOG: "persist-catalog",
  READ_ORDER_STATUS: "read-order-status",
  READ_RUN_CONTEXT: "read-run-context",
  PERSIST_MARKETING_PACK: "persist-marketing-pack",
  PERSIST_SITE_ARTIFACT: "persist-site-artifact",
  VIDEO_RENDER: "video-render",
});

export class CapabilityRegistry {
  #handles = new Map();

  constructor(capabilities = []) {
    for (const capability of capabilities) {
      this.register(capability);
    }
  }

  register({ handle, subject, actions }) {
    if (!handle || !subject || !Array.isArray(actions) || actions.length === 0) {
      throw new ValidationError("Capability requires handle, subject, and actions");
    }
    this.#handles.set(handle, {
      subject,
      actions: new Set(actions),
    });
  }

  authorize(handle, { subject, action }) {
    if (!handle) {
      throw new AuthenticationError();
    }
    const capability = this.#handles.get(handle);
    if (!capability) {
      throw new AuthenticationError();
    }
    if (capability.subject !== subject || !capability.actions.has(action)) {
      throw new AuthorizationError();
    }
    return { subject: capability.subject, action };
  }
}
