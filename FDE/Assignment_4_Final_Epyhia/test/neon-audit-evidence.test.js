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

test("tenant profile returns the business identity without exposing credentials", async () => {
  const repository = new NeonRepository({
    pool: {
      async query(sql, params) {
        assert.match(sql, /FROM tenants WHERE id = \$1/);
        assert.deepEqual(params, ["tenant_demo"]);
        return {
          rowCount: 1,
          rows: [{
            id: "tenant_demo",
            business_name: "Existing Rentals",
            business_slug: "existing-rentals",
            business_email: "hello@example.test",
            business_phone: "555-0100",
            business_address: "1 Main Street",
          }],
        };
      },
    },
  });

  assert.deepEqual(await repository.readTenantProfile({ tenantId: "tenant_demo" }), {
    tenantId: "tenant_demo",
    businessName: "Existing Rentals",
    businessSlug: "existing-rentals",
    businessEmail: "hello@example.test",
    businessPhone: "555-0100",
    businessAddress: "1 Main Street",
  });
});

test("persisted run deliverables restore exact approval-bound payloads", async () => {
  const pack = {
    landingCopy: "Exact stored copy",
    socialPosts: [],
    launchEmail: "Stored email",
    storyboard: {},
  };
  const responses = [
    { rowCount: 1, rows: [{ exists: 1 }] },
    {
      rows: [{
        html_content: "<!doctype html><title>Stored</title>",
        content_hash: "site-hash",
        revision_number: 2,
      }],
    },
    {
      rows: [{
        id: "action_deploy",
        tenant_id: "tenant_demo",
        run_id: "run_demo",
        action_type: "deploy",
        payload_hash: "deploy-hash",
        provider_cost_microdollars: 0,
        status: "PENDING_APPROVAL",
      }],
    },
    { rows: [{ payload_hash: "pack-hash", payload_json: { pack } }] },
    {
      rows: [{
        id: "action_video",
        tenant_id: "tenant_demo",
        run_id: "run_demo",
        action_type: "video-render",
        payload_hash: "video-hash",
        provider_cost_microdollars: 0,
        status: "PENDING_APPROVAL",
      }],
    },
    { rows: [{ approval_status: "PENDING" }] },
  ];
  const repository = new NeonRepository({
    pool: {
      async query() {
        return responses.shift();
      },
    },
  });

  const result = await repository.readRunDeliverables({
    tenantId: "tenant_demo",
    runId: "run_demo",
  });

  assert.equal(result.website.draft.html, "<!doctype html><title>Stored</title>");
  assert.equal(result.website.deployment.action.payloadHash, "deploy-hash");
  assert.deepEqual(result.marketing.pack, pack);
  assert.equal(result.marketing.persisted.packHash, "pack-hash");
  assert.equal(result.marketing.persisted.videoAction.payloadHash, "video-hash");
  assert.equal(result.marketing.persisted.approvalStatus, "PENDING");
  assert.equal(responses.length, 0);
});

test("Website recovery selects the latest passed review and matching draft", async () => {
  const repository = new NeonRepository({
    pool: {
      async query(sql, params) {
        assert.match(sql, /agent_calls\.status = 'COMPLETED'/);
        assert.deepEqual(params, ["run_demo", "tenant_demo"]);
        return {
          rows: [
            {
              id: "review_v2",
              idempotency_key: "web-build:run_demo:review:v2",
              output_text: JSON.stringify({ status: "PASSED", feedback: [] }),
            },
            {
              id: "draft_v2",
              idempotency_key: "web-build:run_demo:draft:v2",
              output_text: JSON.stringify({ html: "<!doctype html><title>Passed</title>" }),
            },
            {
              id: "review_v1",
              idempotency_key: "web-build:run_demo:review:v1",
              output_text: JSON.stringify({ status: "FAILED", feedback: ["Revise"] }),
            },
          ],
        };
      },
    },
  });

  const result = await repository.readCompletedWebsiteReview({
    tenantId: "tenant_demo",
    runId: "run_demo",
  });

  assert.equal(result.revisionNumber, 2);
  assert.equal(result.draft.html, "<!doctype html><title>Passed</title>");
  assert.equal(result.review.status, "PASSED");
  assert.deepEqual(result.evidence, {
    draftCallId: "draft_v2",
    reviewCallId: "review_v2",
  });
});

test("tenant profile returns null for a first-time Auth0 identity", async () => {
  const repository = new NeonRepository({
    pool: {
      async query() {
        return { rowCount: 0, rows: [] };
      },
    },
  });
  assert.equal(
    await repository.readTenantProfile({ tenantId: "tenant_new" }),
    null,
  );
});

test("tenant erasure transaction deletes every tenant-owned Neon table", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("SELECT id FROM tenants")) {
        return { rowCount: 1, rows: [{ id: "tenant_demo" }] };
      }
      return { rowCount: String(sql).startsWith("DELETE") ? 1 : 0, rows: [] };
    },
    release() {},
  };
  const repository = new NeonRepository({
    pool: { async connect() { return client; } },
  });
  const result = await repository.deleteTenantData({ tenantId: "tenant_demo" });
  assert.equal(result.deleted, true);
  const sql = queries.map((query) => query.sql).join("\n");
  for (const table of [
    "deployments",
    "marketing_artifacts",
    "site_artifacts",
    "orders",
    "reservation_items",
    "reservations",
    "customers",
    "rental_items",
    "site_hosts",
    "webhook_events",
    "deployment_projects",
    "actions",
    "agent_calls",
    "onboarding_requests",
    "tasks",
    "runs",
    "brand_documents",
    "tenants",
  ]) {
    assert.match(sql, new RegExp(`DELETE FROM ${table}`));
  }
  assert.match(sql, /COMMIT/);
});
