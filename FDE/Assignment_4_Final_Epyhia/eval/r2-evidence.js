import { fileURLToPath } from "node:url";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

const OBJECT_KEY_PATTERN = /^epyhia-demo\/[A-Za-z0-9][A-Za-z0-9._/-]{0,1000}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function required(name, environment = process.env) {
  const value = environment[name];
  if (!value) throw new Error(`Missing evaluation configuration ${name}`);
  return value;
}

export async function verifyR2Evidence({ objects, client, bucket }) {
  if (!Array.isArray(objects) || objects.length !== 2) {
    throw new Error("Exactly two video objects are required for R2 evidence");
  }
  for (const object of objects) {
    if (
      !OBJECT_KEY_PATTERN.test(object?.key ?? "") ||
      object.key.includes("..") ||
      !HASH_PATTERN.test(object?.contentHash ?? "") ||
      object?.mimeType !== "video/mp4"
    ) {
      throw new Error("Video evidence contains invalid object metadata");
    }
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: object.key }),
    );
    if (
      head.ContentType !== "video/mp4" ||
      !Number.isSafeInteger(head.ContentLength) ||
      head.ContentLength < 1 ||
      head.Metadata?.sha256 !== object.contentHash
    ) {
      throw new Error("R2 object metadata does not match the persisted video artifact");
    }
  }
  return { verified: objects.length };
}

async function main() {
  let inputText = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) inputText += chunk;
  const objects = JSON.parse(inputText);
  const bucket = required("R2_BUCKET");
  const client = new S3Client({
    region: "auto",
    endpoint: required("CLOUDFLARE_R2_S3_URL"),
    credentials: {
      accessKeyId: required("CLOUDFLARE_R2_ACCESS_KEY_ID"),
      secretAccessKey: required("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
    },
  });
  const result = await verifyR2Evidence({ objects, client, bucket });
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`R2 evidence verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
