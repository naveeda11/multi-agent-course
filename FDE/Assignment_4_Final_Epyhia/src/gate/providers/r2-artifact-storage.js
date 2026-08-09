import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sha256 } from "../../shared/canonical.js";
import { ConflictError, ProviderError, ValidationError } from "../../shared/errors.js";

const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export class R2ArtifactStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, client } = {}) {
    if (!bucket) throw new ValidationError("R2_BUCKET is required");
    this.bucket = bucket;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });
  }

  async put({ objectKey, body, mimeType }) {
    if (
      !OBJECT_KEY_PATTERN.test(objectKey ?? "") ||
      objectKey.startsWith("/") ||
      objectKey.includes("..")
    ) {
      throw new ValidationError("R2 objectKey must be a safe relative object key");
    }
    if (!Buffer.isBuffer(body)) throw new ValidationError("R2 artifact body must be a Buffer");
    if (body.length < 1 || body.length > MAX_ARTIFACT_BYTES) {
      throw new ValidationError("R2 artifact must contain between 1 byte and 100 MiB");
    }
    if (typeof mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
      throw new ValidationError("R2 artifact mimeType is invalid");
    }
    const contentHash = sha256(body);
    try {
      const existing = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      if (existing.Metadata?.sha256 === contentHash) {
        return { objectKey, contentHash, bytes: body.length, replayed: true };
      }
      throw new ConflictError("R2 object key is already bound to different content");
    } catch (error) {
      const notFound =
        error?.name === "NotFound" ||
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404;
      if (!notFound) {
        if (error instanceof ConflictError) throw error;
        throw new ProviderError("R2 artifact lookup failed", { cause: error.message });
      }
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentType: mimeType,
          Metadata: { sha256: contentHash },
        }),
      );
      return { objectKey, contentHash, bytes: body.length, replayed: false };
    } catch (error) {
      throw new ProviderError("R2 artifact upload failed", { cause: error.message });
    }
  }
}
