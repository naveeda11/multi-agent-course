import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sha256 } from "../../shared/canonical.js";
import { ConflictError, ProviderError, ValidationError } from "../../shared/errors.js";

const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DEFAULT_VIEW_URL_EXPIRY_SECONDS = 15 * 60;
const MIN_VIEW_URL_EXPIRY_SECONDS = 60;
const MAX_VIEW_URL_EXPIRY_SECONDS = 60 * 60;

function validateObjectKey(objectKey) {
  if (
    !OBJECT_KEY_PATTERN.test(objectKey ?? "") ||
    objectKey.startsWith("/") ||
    objectKey.includes("..")
  ) {
    throw new ValidationError("R2 objectKey must be a safe relative object key");
  }
}

export class R2ArtifactStorage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, client, signer } = {}) {
    if (!bucket) throw new ValidationError("R2_BUCKET is required");
    this.bucket = bucket;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      });
    this.signer = signer ?? getSignedUrl;
  }

  async put({ objectKey, body, mimeType }) {
    validateObjectKey(objectKey);
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

  async createViewUrl({
    objectKey,
    mimeType,
    expiresInSeconds = DEFAULT_VIEW_URL_EXPIRY_SECONDS,
  }) {
    validateObjectKey(objectKey);
    if (typeof mimeType !== "string" || !/^video\/[\w.+-]+$/.test(mimeType)) {
      throw new ValidationError("Only stored video artifacts can receive a view URL");
    }
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < MIN_VIEW_URL_EXPIRY_SECONDS ||
      expiresInSeconds > MAX_VIEW_URL_EXPIRY_SECONDS
    ) {
      throw new ValidationError("R2 view URL expiry must be between 60 and 3600 seconds");
    }
    try {
      const url = await this.signer(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ResponseContentType: mimeType,
          ResponseContentDisposition: "inline",
        }),
        { expiresIn: expiresInSeconds },
      );
      if (new URL(url).protocol !== "https:") {
        throw new Error("signed URL must use HTTPS");
      }
      return {
        url,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    } catch (error) {
      throw new ProviderError("R2 video view URL signing failed", { cause: error.message });
    }
  }

  async deletePrefix(prefix) {
    if (!OBJECT_KEY_PATTERN.test(prefix ?? "") || !prefix.endsWith("/")) {
      throw new ValidationError("R2 deletion prefix must be a safe relative directory");
    }
    let deletedObjects = 0;
    try {
      for (let batch = 0; batch < 1_000; batch += 1) {
        const listed = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1_000 }),
        );
        const objects = (listed.Contents ?? [])
          .map((object) => object.Key)
          .filter(Boolean)
          .map((Key) => ({ Key }));
        if (objects.length === 0) break;
        const deletion = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if ((deletion.Errors ?? []).length > 0) {
          throw new ProviderError("R2 reported an object deletion failure");
        }
        deletedObjects += objects.length;
        if (batch === 999) {
          throw new ProviderError("R2 tenant artifact deletion exceeded its batch limit");
        }
      }
      const remaining = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 }),
      );
      if ((remaining.KeyCount ?? remaining.Contents?.length ?? 0) !== 0) {
        throw new ProviderError("R2 tenant artifact deletion could not be verified");
      }
      return { prefix, deletedObjects };
    } catch (error) {
      if (error instanceof ProviderError || error instanceof ValidationError) throw error;
      throw new ProviderError("R2 tenant artifact deletion failed", { cause: error.message });
    }
  }
}
