import { ConflictError, ValidationError } from "../shared/errors.js";

export class ErasureService {
  constructor({ repository, deploymentProvider, storage, stripeProvider }) {
    this.repository = repository;
    this.deploymentProvider = deploymentProvider;
    this.storage = storage;
    this.stripeProvider = stripeProvider;
  }

  async erase({ tenantId }) {
    if (!this.repository?.readErasureManifest || !this.repository?.deleteTenantData) {
      throw new ConflictError("Tenant erasure persistence is not configured");
    }
    if (!this.storage || !this.stripeProvider) {
      throw new ConflictError("Every tenant erasure provider must be configured");
    }
    if (typeof tenantId !== "string" || tenantId.length < 3 || tenantId.length > 200) {
      throw new ValidationError("tenantId is invalid");
    }

    const manifest = await this.repository.readErasureManifest({ tenantId });
    let cloudflare = { deleted: false, reason: "no-project" };
    let r2 = { deletedObjects: 0 };
    let stripe = { sessions: [] };
    let database = { tenantId, deleted: false, alreadyDeleted: true };

    if (manifest) {
      if (manifest.projectName) {
        cloudflare = await this.deploymentProvider.deleteProject({
          projectName: manifest.projectName,
          liveUrl: manifest.liveUrl,
        });
      }
      r2 = await this.storage.deletePrefix(manifest.r2Prefix);
      stripe = await this.stripeProvider.eraseCheckoutSessions(
        manifest.stripeCheckoutSessionIds,
      );
      database = await this.repository.deleteTenantData({ tenantId });
    }

    return {
      tenantId,
      deleted: true,
      cloudflare,
      r2,
      stripe,
      database,
      auth0: { deleted: false, reason: "identity-retained" },
    };
  }
}
