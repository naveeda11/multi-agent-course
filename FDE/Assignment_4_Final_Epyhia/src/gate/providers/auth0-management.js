import { ProviderError, ValidationError } from "../../shared/errors.js";

export class Auth0ManagementProvider {
  constructor({ issuerBaseUrl, clientId, clientSecret, fetchImpl = fetch }) {
    let issuer;
    try {
      issuer = new URL(issuerBaseUrl);
    } catch {
      throw new ValidationError("AUTH0_MANAGEMENT_ISSUER_BASE_URL must be a valid URL");
    }
    if (issuer.protocol !== "https:") {
      throw new ValidationError("Auth0 Management API requires HTTPS");
    }
    if (!clientId || !clientSecret) {
      throw new ValidationError("Auth0 Management API credentials are required");
    }
    this.baseUrl = issuer.href.replace(/\/$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
  }

  async deleteUser(userId) {
    if (typeof userId !== "string" || userId.length < 3 || userId.length > 255) {
      throw new ValidationError("Auth0 user id is invalid");
    }
    const tokenResponse = await this.fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `${this.baseUrl}/api/v2/`,
      }),
    });
    if (!tokenResponse.ok) {
      throw new ProviderError("Unable to authorize Auth0 user deletion", {
        status: tokenResponse.status,
      });
    }
    const token = await tokenResponse.json();
    if (!token.access_token) {
      throw new ProviderError("Auth0 Management API did not return an access token");
    }
    const response = await this.fetch(
      `${this.baseUrl}/api/v2/users/${encodeURIComponent(userId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    if (response.status !== 204 && response.status !== 404) {
      throw new ProviderError("Auth0 user deletion failed", { status: response.status });
    }
    return { userId, deleted: true };
  }
}
