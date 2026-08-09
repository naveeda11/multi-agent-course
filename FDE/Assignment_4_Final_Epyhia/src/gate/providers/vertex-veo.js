import { GoogleAuth } from "google-auth-library";
import { ProviderError, ValidationError } from "../../shared/errors.js";

const MODEL = "veo-3.1-fast-generate-001";
const PRICE_MICRODOLLARS_PER_SECOND = 80_000;

function requiredText(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

export class VertexVeoProvider {
  constructor({
    projectId,
    credentialsFile,
    credentials,
    location = "us-central1",
    auth,
    fetchImpl = fetch,
    pollIntervalMs = 10_000,
    maxPollAttempts = 60,
  } = {}) {
    this.projectId = requiredText(projectId, "GOOGLE_CLOUD_PROJECT");
    this.location = requiredText(location, "GOOGLE_CLOUD_LOCATION");
    this.fetch = fetchImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollAttempts = maxPollAttempts;
    this.auth = auth ?? new GoogleAuth({
      projectId: this.projectId,
      ...(credentials
        ? { credentials }
        : { keyFile: requiredText(credentialsFile, "GOOGLE_APPLICATION_CREDENTIALS") }),
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    this.mode = "LIVE";
  }

  async generate({ prompt, aspectRatio, durationSeconds, resolution, generateAudio }) {
    requiredText(prompt, "video prompt");
    if (!["16:9", "9:16"].includes(aspectRatio)) {
      throw new ValidationError("Veo aspectRatio must be 16:9 or 9:16");
    }
    if (![4, 6, 8].includes(durationSeconds)) {
      throw new ValidationError("Veo durationSeconds must be 4, 6, or 8");
    }
    if (!["720p", "1080p"].includes(resolution) || generateAudio !== false) {
      throw new ValidationError("EPYHIA Veo requires 720p/1080p and audio disabled");
    }
    const authClient = await this.auth.getClient();
    const tokenResult = await authClient.getAccessToken();
    const token = typeof tokenResult === "string" ? tokenResult : tokenResult?.token;
    if (!token) throw new ProviderError("Google authentication returned no access token");
    const modelPath = `projects/${this.projectId}/locations/${this.location}/publishers/google/models/${MODEL}`;
    const endpoint = `https://${this.location}-aiplatform.googleapis.com/v1/${modelPath}:predictLongRunning`;
    const submitted = await this.#json(endpoint, token, {
      instances: [{ prompt }],
      parameters: {
        aspectRatio,
        durationSeconds,
        resolution,
        generateAudio: false,
        sampleCount: 1,
      },
    });
    if (!submitted.name) throw new ProviderError("Veo returned no operation name");
    const pollEndpoint = `https://${this.location}-aiplatform.googleapis.com/v1/${modelPath}:fetchPredictOperation`;
    let result;
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      result = await this.#json(pollEndpoint, token, { operationName: submitted.name });
      if (result.done) break;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    if (!result?.done) throw new ProviderError("Veo generation timed out");
    if (result.error) {
      throw new ProviderError("Veo generation failed", { cause: result.error.message });
    }
    const generated = result.response?.generatedVideos?.[0]?.video;
    const alternate = result.response?.videos?.[0];
    const incurredCostMicrodollars = durationSeconds * PRICE_MICRODOLLARS_PER_SECOND;
    const source = generated?.uri ?? alternate?.gcsUri;
    if (!alternate?.bytesBase64Encoded && !source) {
      throw new ProviderError("Veo returned no video bytes or URI");
    }
    let body;
    try {
      if (alternate?.bytesBase64Encoded) {
        body = Buffer.from(alternate.bytesBase64Encoded, "base64");
      } else {
        body = await this.#download(source, token);
      }
      if (body.length === 0) throw new ProviderError("Veo returned an empty video");
    } catch (error) {
      throw new ProviderError("Veo output retrieval failed after generation", {
        cause: error.message,
        incurredCostMicrodollars,
      });
    }
    return {
      body,
      mimeType: "video/mp4",
      providerReference: submitted.name,
      providerCostMicrodollars: incurredCostMicrodollars,
    };
  }

  async #json(url, token, body) {
    const response = await this.fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ProviderError("Vertex AI request failed", { status: response.status });
    }
    return response.json();
  }

  async #download(source, token) {
    let url = source;
    if (source.startsWith("gs://")) {
      const [bucket, ...parts] = source.slice(5).split("/");
      url = `https://storage.googleapis.com/${bucket}/${parts.map(encodeURIComponent).join("/")}`;
    }
    const response = await this.fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new ProviderError("Veo video download failed", { status: response.status });
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
