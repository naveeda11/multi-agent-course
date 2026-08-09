import { ValidationError } from "../shared/errors.js";

const ITEM_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value, name, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new ValidationError(`${name} must contain between 1 and ${max} characters`);
  }
}

export class CatalogService {
  constructor({ repository }) {
    this.repository = repository;
  }

  async persist({ tenantId, runId, items, idempotencyKey, agentName = "ops" }) {
    text(tenantId, "tenantId", 200);
    text(runId, "runId", 200);
    text(idempotencyKey, "idempotencyKey", 200);
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      throw new ValidationError("Catalog must contain between 1 and 50 rental items");
    }
    const keys = new Set();
    const normalized = items.map((item) => {
      if (!ITEM_KEY_PATTERN.test(item?.itemKey ?? "")) {
        throw new ValidationError("Catalog itemKey must be a lowercase kebab-case key");
      }
      if (keys.has(item.itemKey)) {
        throw new ValidationError("Catalog itemKey values must be unique");
      }
      keys.add(item.itemKey);
      text(item.name, "catalog item name", 200);
      text(item.description, "catalog item description", 2_000);
      if (
        !Number.isInteger(item.availableQuantity) ||
        item.availableQuantity < 1 ||
        item.availableQuantity > 100_000
      ) {
        throw new ValidationError(
          "Catalog availableQuantity must be an integer between 1 and 100,000",
        );
      }
      if (
        !Number.isInteger(item.dayRateCents) ||
        item.dayRateCents < 1 ||
        item.dayRateCents > 100_000_000
      ) {
        throw new ValidationError(
          "Catalog dayRateCents must be an integer between 1 and 100,000,000",
        );
      }
      const currency = item.currency?.toLowerCase();
      if (!/^[a-z]{3}$/.test(currency ?? "")) {
        throw new ValidationError("Catalog currency must be a three-letter lowercase code");
      }
      return {
        itemKey: item.itemKey,
        name: item.name.trim(),
        description: item.description.trim(),
        availableQuantity: item.availableQuantity,
        dayRateCents: item.dayRateCents,
        currency,
      };
    });
    if (new Set(normalized.map((item) => item.currency)).size !== 1) {
      throw new ValidationError("All catalog items must use one currency");
    }
    return this.repository.persistCatalog({
      tenantId,
      runId,
      items: normalized,
      idempotencyKey,
      agentName,
    });
  }
}
