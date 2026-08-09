import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyR2Evidence } from "../eval/r2-evidence.js";

const objects = [
  {
    key: "epyhia-demo/tenant/run/video/landscape.mp4",
    contentHash: "a".repeat(64),
    mimeType: "video/mp4",
  },
  {
    key: "epyhia-demo/tenant/run/video/vertical.mp4",
    contentHash: "b".repeat(64),
    mimeType: "video/mp4",
  },
];

test("live evaluation requires both R2 objects to match persisted hashes", async () => {
  let index = 0;
  const result = await verifyR2Evidence({
    objects,
    bucket: "demo-bucket",
    client: {
      async send(command) {
        assert.equal(command.input.Bucket, "demo-bucket");
        return {
          ContentType: "video/mp4",
          ContentLength: 1_024,
          Metadata: { sha256: objects[index++].contentHash },
        };
      },
    },
  });
  assert.equal(result.verified, 2);
});

test("live evaluation rejects an R2 hash that differs from Neon", async () => {
  await assert.rejects(
    verifyR2Evidence({
      objects,
      bucket: "demo-bucket",
      client: {
        async send() {
          return {
            ContentType: "video/mp4",
            ContentLength: 1_024,
            Metadata: { sha256: "f".repeat(64) },
          };
        },
      },
    }),
    /does not match/,
  );
});
