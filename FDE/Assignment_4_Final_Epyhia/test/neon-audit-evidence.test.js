import assert from "node:assert/strict";
import { test } from "node:test";
import { NeonRepository } from "../src/gate/neon-repository.js";

test("run audit exposes tenant-bound idempotency evidence", async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM runs WHERE")) {
        return {
          rowCount: 1,
          rows: [{ status: "EXECUTING", approved_budget_microdollars: "2000000" }],
        };
      }
      if (sql.includes("FROM agent_calls WHERE run_id") && sql.includes("ORDER BY")) {
        return { rows: [] };
      }
      if (sql.includes("FROM actions WHERE run_id") && sql.includes("ORDER BY")) {
        return { rows: [] };
      }
      if (sql.includes("AS model_cost")) {
        return { rows: [{ model_cost: "0", provider_cost: "0" }] };
      }
      if (sql.includes("AS deployment_count")) {
        return {
          rows: [{
            deployment_count: "1",
            site_artifact_count: "1",
            paid_order_count: "1",
            duplicate_order_groups: "0",
            project_name: "epyhia-demo",
            live_url: "https://epyhia-demo.pages.dev",
            deployment_action_id: "action_deploy",
            order_ids: ["order_demo"],
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const repository = new NeonRepository({ pool });

  const audit = await repository.readRunAudit({
    tenantId: "tenant_demo",
    runId: "run_demo",
  });

  assert.deepEqual(audit.idempotencyEvidence, {
    deploymentCount: 1,
    siteArtifactCount: 1,
    paidOrderCount: 1,
    duplicateOrderGroups: 0,
    projectName: "epyhia-demo",
    liveUrl: "https://epyhia-demo.pages.dev",
    deploymentActionId: "action_deploy",
    orderIds: ["order_demo"],
  });
  const evidenceQuery = queries.find(({ sql }) => sql.includes("AS deployment_count"));
  assert.deepEqual(evidenceQuery.params, ["tenant_demo", "run_demo"]);
  assert.match(evidenceQuery.sql, /orders WHERE tenant_id = \$1/);
  assert.match(evidenceQuery.sql, /site_artifacts WHERE run_id = \$2/);
});
