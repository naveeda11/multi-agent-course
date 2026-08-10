import assert from "node:assert/strict";
import { test } from "node:test";
import { R2ArtifactStorage } from "../src/gate/providers/r2-artifact-storage.js";
import { ConflictError, ValidationError } from "../src/shared/errors.js";

test("uploads an R2 artifact with a content hash and replays identical content", async () => {
  const calls = [];
  let storedHash;
  const storage = new R2ArtifactStorage({
    bucket: "demo-bucket",
    client: {
      async send(command) {
        calls.push(command.input);
        if (Object.hasOwn(command.input, "Metadata")) {
          storedHash = command.input.Metadata.sha256;
          return {};
        }
        if (!storedHash) {
          const error = new Error("missing");
          error.name = "NotFound";
          throw error;
        }
        return { Metadata: { sha256: storedHash } };
      },
    },
  });
  const body = Buffer.from("demo artifact");
  const first = await storage.put({
    objectKey: "tenant/run/video.mp4",
    body,
    mimeType: "video/mp4",
  });
  const second = await storage.put({
    objectKey: "tenant/run/video.mp4",
    body,
    mimeType: "video/mp4",
  });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(calls.filter((call) => Object.hasOwn(call, "Metadata")).length, 1);
});

test("rejects overwriting an R2 key with different content", async () => {
  const storage = new R2ArtifactStorage({
    bucket: "demo-bucket",
    client: {
      async send() {
        return { Metadata: { sha256: "different" } };
      },
    },
  });
  await assert.rejects(
    storage.put({
      objectKey: "tenant/run/video.mp4",
      body: Buffer.from("new content"),
      mimeType: "video/mp4",
    }),
    ConflictError,
  );
});

test("rejects unsafe R2 object keys", async () => {
  const storage = new R2ArtifactStorage({ bucket: "demo-bucket", client: {} });
  await assert.rejects(
    storage.put({
      objectKey: "../secret",
      body: Buffer.from("x"),
      mimeType: "text/plain",
    }),
    ValidationError,
  );
});

test("creates a temporary HTTPS viewing URL for a stored video", async () => {
  let signedCommand;
  let signedOptions;
  const storage = new R2ArtifactStorage({
    bucket: "demo-bucket",
    client: {},
    async signer(_client, command, options) {
      signedCommand = command.input;
      signedOptions = options;
      return "https://r2.example.test/private-video?signature=test";
    },
  });

  const result = await storage.createViewUrl({
    objectKey: "tenant/run/video/landscape.mp4",
    mimeType: "video/mp4",
  });

  assert.equal(result.url, "https://r2.example.test/private-video?signature=test");
  assert.match(result.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(signedCommand.Bucket, "demo-bucket");
  assert.equal(signedCommand.Key, "tenant/run/video/landscape.mp4");
  assert.equal(signedCommand.ResponseContentDisposition, "inline");
  assert.deepEqual(signedOptions, { expiresIn: 900 });
});

test("refuses to create view URLs for unsafe or non-video objects", async () => {
  const storage = new R2ArtifactStorage({ bucket: "demo-bucket", client: {} });
  await assert.rejects(
    storage.createViewUrl({ objectKey: "../secret", mimeType: "video/mp4" }),
    ValidationError,
  );
  await assert.rejects(
    storage.createViewUrl({ objectKey: "tenant/run/file.txt", mimeType: "text/plain" }),
    ValidationError,
  );
});

test("deletes and verifies every object under the tenant prefix", async () => {
  let listed = false;
  const calls = [];
  const storage = new R2ArtifactStorage({
    bucket: "demo-bucket",
    client: {
      async send(command) {
        calls.push(command.input);
        if (Object.hasOwn(command.input, "Delete")) {
          listed = true;
          return {};
        }
        if (!listed) {
          return { KeyCount: 2, Contents: [{ Key: "tenant/a" }, { Key: "tenant/b" }] };
        }
        return { KeyCount: 0, Contents: [] };
      },
    },
  });
  const result = await storage.deletePrefix("tenant/");
  assert.equal(result.deletedObjects, 2);
  assert.equal(calls.filter((call) => Object.hasOwn(call, "Delete")).length, 1);
});
