import assert from "node:assert/strict";
import { test } from "node:test";
import { VideoService } from "../src/gate/video-service.js";
import { VertexVeoProvider } from "../src/gate/providers/vertex-veo.js";
import { ApprovalRequiredError } from "../src/shared/errors.js";
import { sha256 } from "../src/shared/canonical.js";

const approvedAction = {
  id: "action_video",
  tenantId: "tenant_demo",
  runId: "run_demo",
  agentName: "marketer",
  actionType: "video-render",
  approvalStatus: "APPROVED",
  status: "APPROVED",
};

const payload = {
  brandDocumentId: "brand_demo",
  durationSeconds: 4,
  resolution: "720p",
  generateAudio: false,
  estimatedCostMicrodollars: 640_000,
  outputs: [
    { variant: "landscape", artifactType: "VIDEO_LANDSCAPE", aspectRatio: "16:9", prompt: "Landscape prompt" },
    { variant: "vertical", artifactType: "VIDEO_VERTICAL", aspectRatio: "9:16", prompt: "Vertical prompt" },
  ],
};

test("VideoService refuses rendering before exact payload approval", async () => {
  const service = new VideoService({
    repository: {
      async requireAction() { return { ...approvedAction, approvalStatus: "PENDING" }; },
    },
  });
  await assert.rejects(service.execute({ actionId: approvedAction.id }), ApprovalRequiredError);
});

test("VideoService renders two approved variants, stores them, and logs bounded cost", async () => {
  const generated = [];
  const stored = [];
  const completions = [];
  const service = new VideoService({
    repository: {
      async requireAction() { return approvedAction; },
      async claimForExecution() { return { action: approvedAction, claimed: true }; },
      async getPayload() { return payload; },
      async completeVideoRender(input) {
        completions.push(input);
        return { ...approvedAction, status: "EXECUTED", providerCostMicrodollars: input.providerCostMicrodollars };
      },
      async failPaidAction() { throw new Error("should not fail"); },
    },
    provider: {
      async generate(input) {
        generated.push(input);
        return {
          body: Buffer.from(input.aspectRatio),
          mimeType: "video/mp4",
          providerReference: `operation-${input.aspectRatio}`,
          providerCostMicrodollars: 320_000,
        };
      },
    },
    storage: {
      async put(input) {
        stored.push(input);
        return { contentHash: sha256(input.body), replayed: false };
      },
    },
  });
  const result = await service.execute({ actionId: approvedAction.id });
  assert.deepEqual(generated.map((call) => call.aspectRatio), ["16:9", "9:16"]);
  assert.equal(stored.length, 2);
  assert.match(stored[0].objectKey, new RegExp(`${sha256(Buffer.from("16:9"))}\\.mp4$`));
  assert.equal(completions[0].providerCostMicrodollars, 640_000);
  assert.equal(result.action.status, "EXECUTED");
});

test("VideoService logs partial spend and requires fresh approval after failure", async () => {
  const failures = [];
  let calls = 0;
  const service = new VideoService({
    repository: {
      async requireAction() { return approvedAction; },
      async claimForExecution() { return { action: approvedAction, claimed: true }; },
      async getPayload() { return payload; },
      async failPaidAction(input) { failures.push(input); },
    },
    provider: {
      async generate(input) {
        calls += 1;
        if (calls === 2) throw new Error("second render failed");
        return {
          body: Buffer.from(input.aspectRatio),
          mimeType: "video/mp4",
          providerReference: "operation-first",
          providerCostMicrodollars: 320_000,
        };
      },
    },
    storage: {
      async put(input) {
        return { contentHash: sha256(input.body), replayed: false };
      },
    },
  });
  await assert.rejects(
    service.execute({ actionId: approvedAction.id }),
    /Approved Veo render failed/,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].providerCostMicrodollars, 320_000);
});

test("VideoService logs provider-reported spend when generated output retrieval fails", async () => {
  const failures = [];
  const service = new VideoService({
    repository: {
      async requireAction() { return approvedAction; },
      async claimForExecution() { return { action: approvedAction, claimed: true }; },
      async getPayload() { return payload; },
      async failPaidAction(input) { failures.push(input); },
    },
    provider: {
      async generate() {
        const error = new Error("download failed");
        error.details = { incurredCostMicrodollars: 320_000 };
        throw error;
      },
    },
    storage: {},
  });

  await assert.rejects(
    service.execute({ actionId: approvedAction.id }),
    /Approved Veo render failed/,
  );
  assert.equal(failures[0].providerCostMicrodollars, 320_000);
});

test("VertexVeoProvider submits and polls the fixed Fast model without audio", async () => {
  const requests = [];
  const responses = [
    { name: "projects/demo/locations/us-central1/publishers/google/models/veo/operations/op1" },
    {
      done: true,
      response: { videos: [{ bytesBase64Encoded: Buffer.from("video").toString("base64") }] },
    },
  ];
  const provider = new VertexVeoProvider({
    projectId: "demo-project",
    credentialsFile: "/unused-in-test.json",
    auth: {
      async getClient() {
        return { async getAccessToken() { return { token: "test-token" }; } };
      },
    },
    pollIntervalMs: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, async json() { return responses.shift(); } };
    },
  });
  const result = await provider.generate({
    prompt: "Slow dolly toward arranged chairs. No text, logos, UI, or audio.",
    aspectRatio: "16:9",
    durationSeconds: 4,
    resolution: "720p",
    generateAudio: false,
  });
  const submitted = JSON.parse(requests[0].options.body);
  assert.match(requests[0].url, /veo-3\.1-fast-generate-001:predictLongRunning$/);
  assert.equal(submitted.parameters.generateAudio, false);
  assert.equal(result.body.toString(), "video");
  assert.equal(result.providerCostMicrodollars, 320_000);
});

test("VertexVeoProvider reports incurred cost when a completed video cannot be downloaded", async () => {
  const responses = [
    { ok: true, body: { name: "operations/op-download" } },
    {
      ok: true,
      body: {
        done: true,
        response: { videos: [{ gcsUri: "gs://demo-output/video.mp4" }] },
      },
    },
    { ok: false, body: {} },
  ];
  const provider = new VertexVeoProvider({
    projectId: "demo-project",
    credentialsFile: "/unused-in-test.json",
    auth: {
      async getClient() {
        return { async getAccessToken() { return { token: "test-token" }; } };
      },
    },
    pollIntervalMs: 0,
    fetchImpl: async () => {
      const response = responses.shift();
      return {
        ok: response.ok,
        status: response.ok ? 200 : 502,
        async json() { return response.body; },
      };
    },
  });

  await assert.rejects(
    provider.generate({
      prompt: "Slow dolly toward arranged chairs. No text, logos, UI, or audio.",
      aspectRatio: "16:9",
      durationSeconds: 4,
      resolution: "720p",
      generateAudio: false,
    }),
    (error) =>
      error.details?.incurredCostMicrodollars === 320_000 &&
      /retrieval failed/.test(error.message),
  );
});
