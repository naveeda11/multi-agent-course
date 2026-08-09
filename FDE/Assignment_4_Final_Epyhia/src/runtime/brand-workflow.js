function generationResult(result) {
  if (result.status === "fulfilled") {
    return { status: "COMPLETED", value: result.value };
  }
  return {
    status: "FAILED",
    error: {
      code: result.reason?.code ?? "GENERATION_FAILED",
      message: result.reason?.message ?? "Generation failed",
    },
  };
}

export class BrandWorkflow {
  constructor({ adminGateClient, marketer, webBuilder }) {
    this.adminGateClient = adminGateClient;
    this.marketer = marketer;
    this.webBuilder = webBuilder;
  }

  async approveAndGenerate({
    tenantId,
    runId,
    brandDocumentId,
    contentHash,
    approvedBy,
  }) {
    const approval = await this.adminGateClient.approveBrandDocument({
      tenantId,
      runId,
      brandDocumentId,
      contentHash,
      approvedBy,
      idempotencyKey: `brand-approval:${brandDocumentId}`,
    });
    const [website, marketing] = await Promise.allSettled([
      this.webBuilder.buildAndRequestDeploy({
        tenantId,
        runId,
        idempotencyKey: `web-build:${runId}`,
      }),
      this.marketer.createAndPersistPack({
        tenantId,
        runId,
        idempotencyKey: `marketing:${runId}`,
      }),
    ]);
    return {
      approval,
      generation: {
        website: generationResult(website),
        marketing: generationResult(marketing),
      },
    };
  }

  async approveMarketingPack({ tenantId, runId, packHash, approvedBy }) {
    return this.adminGateClient.approveMarketingPack({
      tenantId,
      runId,
      packHash,
      approvedBy,
      idempotencyKey: `marketing-approval:${runId}`,
    });
  }

  async reviseArtifact({
    tenantId,
    sourceRunId,
    artifactType,
    feedback,
    approvedBudgetMicrodollars,
    approvedBy,
    idempotencyKey,
  }) {
    const revision = await this.adminGateClient.createArtifactRevision({
      tenantId,
      sourceRunId,
      artifactType,
      feedback,
      approvedBudgetMicrodollars,
      approvedBy,
      idempotencyKey: `${idempotencyKey}:run`,
    });
    const workerInput = {
      tenantId,
      runId: revision.runId,
      revisionFeedback: [feedback],
      idempotencyKey: `${idempotencyKey}:generate`,
    };
    const generated = artifactType === "WEB_BUILD"
      ? await this.webBuilder.buildAndRequestDeploy(workerInput)
      : await this.marketer.createAndPersistPack(workerInput);
    return { revision, generated };
  }
}
