export class OnboardingRuntime {
  constructor({ controlGateClient, strategist, ops }) {
    this.controlGateClient = controlGateClient;
    this.strategist = strategist;
    this.ops = ops;
  }

  async onboard({
    tenant,
    originalBrief,
    approvedBudgetMicrodollars,
    approvedBy,
    idempotencyKey,
    clarificationAnswers = [],
    clarificationRound = 0,
  }) {
    const shell = await this.controlGateClient.createRunShell({
      tenant,
      originalBrief,
      approvedBudgetMicrodollars,
      approvedBy,
      idempotencyKey,
    });
    const strategy = await this.strategist.createBusinessPlan({
      tenantId: tenant.id,
      runId: shell.runId,
      tenant,
      originalBrief,
      clarificationAnswers,
      idempotencyKey: `${idempotencyKey}:strategist-plan:v${clarificationRound + 1}`,
    });
    if (strategy.status === "NEEDS_CLARIFICATION") {
      return {
        shell,
        strategy,
        finalized: null,
        catalog: null,
        status: "AWAITING_CLARIFICATION",
      };
    }
    const finalized = await this.ops.finalizeRun({
      tenantId: tenant.id,
      runId: shell.runId,
      completedBrief: strategy.completedBrief,
      brandDocument: strategy.brandDocument,
      taskPlan: strategy.taskPlan,
      idempotencyKey: `${idempotencyKey}:finalize`,
    });
    const catalog = await this.ops.persistCatalog({
      tenantId: tenant.id,
      runId: shell.runId,
      items: strategy.catalog,
      idempotencyKey: `${idempotencyKey}:catalog`,
    });
    return { shell, strategy, finalized, catalog, status: "EXECUTING" };
  }
}
