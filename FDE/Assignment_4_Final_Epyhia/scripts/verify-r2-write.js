import { R2ArtifactStorage } from "../src/gate/providers/r2-artifact-storage.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const storage = new R2ArtifactStorage({
  endpoint: required("CLOUDFLARE_R2_S3_URL"),
  accessKeyId: required("CLOUDFLARE_R2_ACCESS_KEY_ID"),
  secretAccessKey: required("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
  bucket: required("R2_BUCKET"),
});
const result = await storage.put({
  objectKey: "epyhia-demo/verification/v1.json",
  body: Buffer.from(
    JSON.stringify({ purpose: "EPYHIA demo R2 write verification", version: 1 }),
  ),
  mimeType: "application/json",
});
process.stdout.write(
  `R2 namespaced demo artifact: ${result.replayed ? "verified existing" : "written and verified"}\n`,
);
