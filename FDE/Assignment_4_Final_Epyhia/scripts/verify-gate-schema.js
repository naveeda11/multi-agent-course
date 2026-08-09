import { NeonRepository } from "../src/gate/neon-repository.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for Tier 3 schema verification");
}

const expectedTables = [
  "actions",
  "agent_calls",
  "brand_documents",
  "customers",
  "deployment_projects",
  "deployments",
  "marketing_artifacts",
  "onboarding_requests",
  "orders",
  "rental_items",
  "reservation_items",
  "reservations",
  "runs",
  "schema_migrations",
  "site_hosts",
  "site_artifacts",
  "tasks",
  "tenants",
  "webhook_events",
];
const expectedRunColumns = [
  "original_brief",
  "completed_brief",
  "brief_hash",
  "brand_document_id",
  "approved_budget_microdollars",
  "budget_approved_by",
  "status",
];

const repository = new NeonRepository({ connectionString });
try {
  const tables = await repository.pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name`,
    [expectedTables],
  );
  const migrations = await repository.pool.query(
    `SELECT version FROM schema_migrations
     WHERE version = ANY($1::text[])`,
    [[
      "001_core",
      "002_business_operations",
      "003_action_gate",
      "004_checkout_trace",
      "005_catalog_keys",
      "006_site_artifacts",
      "007_action_execution_recovery",
      "008_tenant_erasure",
    ]],
  );
  const columns = await repository.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'runs'
       AND column_name = ANY($1::text[])`,
    [expectedRunColumns],
  );
  const checkoutColumns = await repository.pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND (
       (table_name = 'reservations' AND column_name = 'run_id')
       OR (table_name = 'rental_items' AND column_name = 'item_key')
    )`,
  );
  const actionRecoveryColumns = await repository.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'actions'
       AND column_name = 'execution_started_at'`,
  );
  const erasureColumns = await repository.pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'webhook_events'
       AND column_name = 'tenant_id'`,
  );
  const parser = await repository.pool.connect();
  let criticalStatementsPrepared = false;
  try {
    await parser.query(
      `PREPARE epyhia_web_task_completion(text, text, text) AS
       UPDATE tasks SET status = 'COMPLETE', output_ref = $2, updated_at = now()
       WHERE run_id = $1 AND tenant_id = $3 AND task_type = 'WEB_BUILD'`,
    );
    await parser.query(
      `PREPARE epyhia_run_completion(text) AS
       UPDATE runs SET status = 'COMPLETED', completed_at = now()
       WHERE id = $1 AND NOT EXISTS (
         SELECT 1 FROM tasks
         WHERE tasks.run_id = runs.id AND tasks.status <> 'COMPLETE'
       )`,
    );
    await parser.query(
      `PREPARE epyhia_video_limit(text) AS
       SELECT COUNT(*) AS count FROM actions
       WHERE tenant_id = $1 AND action_type = 'video-render'`,
    );
    await parser.query(
      `PREPARE epyhia_reservation_item_insert(
         text, text, text, integer, bigint, integer, bigint
       ) AS
       INSERT INTO reservation_items (
         id, reservation_id, rental_item_id, quantity,
         day_rate_cents, rental_days, line_total_cents
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    );
    await parser.query(
      `PREPARE epyhia_paid_action_failure(text, bigint, text) AS
       UPDATE actions SET status = 'FAILED', approval_status = 'PENDING',
         approved_by = NULL, approved_at = NULL,
         execution_started_at = NULL,
         provider_cost_microdollars = provider_cost_microdollars + $2,
         failure_message = $3
       WHERE id = $1 AND action_type = 'video-render'`,
    );
    await parser.query(
      `PREPARE epyhia_agent_call_recovery(text, text, text) AS
       SELECT id, request_hash, status,
         started_at <= now() - interval '15 minutes' AS stale
       FROM agent_calls
       WHERE run_id = $1 AND agent_name = $2 AND idempotency_key = $3
       FOR UPDATE`,
    );
    await parser.query(
      `PREPARE epyhia_action_execution_recovery(text) AS
       UPDATE actions SET execution_started_at = now(), failure_message = NULL
       WHERE id = $1 AND status = 'EXECUTING'
         AND execution_started_at <= now() - interval '15 minutes'`,
    );
    await parser.query(
      `PREPARE epyhia_video_cost_completion(text, bigint) AS
       UPDATE actions SET
         provider_cost_microdollars = provider_cost_microdollars + $2,
         execution_started_at = NULL, status = 'EXECUTED'
       WHERE id = $1 AND action_type = 'video-render'`,
    );
    criticalStatementsPrepared = true;
  } finally {
    await parser.query("DEALLOCATE ALL");
    parser.release();
  }

  const checks = {
    "migrations 001-008": migrations.rowCount === 8,
    "required tables": tables.rowCount === expectedTables.length,
    "run-shell columns": columns.rowCount === expectedRunColumns.length,
    "checkout trace columns": checkoutColumns.rowCount === 2,
    "action recovery column": actionRecoveryColumns.rowCount === 1,
    "tenant erasure trace column": erasureColumns.rowCount === 1,
    "critical SQL statements": criticalStatementsPrepared,
  };
  for (const [name, passed] of Object.entries(checks)) {
    process.stdout.write(`${name}: ${passed ? "present" : "incomplete"}\n`);
  }
  if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await repository.close();
}
