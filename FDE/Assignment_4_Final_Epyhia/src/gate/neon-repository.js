import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { newId, payloadHash, sha256 } from "../shared/canonical.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";

const { Pool } = pg;
const migrationDirectoryPath = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);
const STALE_EXECUTION_MS = 15 * 60 * 1000;

function parseAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    agentName: row.agent_name,
    actionType: row.action_type,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
    mode: row.mode,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at?.toISOString?.() ?? row.approved_at,
    providerReference: row.provider_reference,
    providerCostMicrodollars: Number(row.provider_cost_microdollars ?? 0),
    status: row.status,
    failureMessage: row.failure_message,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    executionStartedAt:
      row.execution_started_at?.toISOString?.() ?? row.execution_started_at,
    executedAt: row.executed_at?.toISOString?.() ?? row.executed_at,
  };
}

export function cloudflareProjectName(businessSlug) {
  const direct = `epyhia-${businessSlug}`;
  if (direct.length <= 58) return direct;
  return `epyhia-${businessSlug.slice(0, 42)}-${sha256(businessSlug).slice(0, 8)}`;
}

export class NeonRepository {
  constructor({ connectionString, pool } = {}) {
    this.pool =
      pool ??
      new Pool({
        connectionString,
        ssl: { rejectUnauthorized: true },
        enableChannelBinding: true,
        max: 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
  }

  async checkConnection() {
    const result = await this.pool.query("SELECT 1 AS connected");
    return result.rows[0]?.connected === 1;
  }

  async migrate() {
    const migrationFiles = (await readdir(migrationDirectoryPath))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [739_241_004]);
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
      );
      for (const filename of migrationFiles) {
        const version = filename.slice(0, -4);
        const applied = await client.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1",
          [version],
        );
        if (applied.rowCount > 0) continue;
        const sql = await readFile(`${migrationDirectoryPath}/${filename}`, "utf8");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async findActionById(actionId, client = this.pool) {
    const result = await client.query("SELECT * FROM actions WHERE id = $1", [actionId]);
    return parseAction(result.rows[0]);
  }

  async requireAction(actionId, client = this.pool) {
    const action = await this.findActionById(actionId, client);
    if (!action) throw new NotFoundError(`Action ${actionId} was not found`);
    return action;
  }

  async getDeployment(tenantId) {
    const result = await this.pool.query(
      "SELECT * FROM deployments WHERE tenant_id = $1",
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  async createPendingAction({
    tenantId,
    runId,
    agentName,
    actionType,
    payloadHash: actionPayloadHash,
    idempotencyKey,
    mode,
    payload,
    approvalRequired,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:${actionType}:${idempotencyKey}`,
      ]);
      const run = await client.query(
        "SELECT tenant_id FROM runs WHERE id = $1 FOR SHARE",
        [runId],
      );
      if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the action tenant");
      }
      const existing = await client.query(
        `SELECT * FROM actions
         WHERE tenant_id = $1 AND action_type = $2 AND idempotency_key = $3`,
        [tenantId, actionType, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        const action = parseAction(existing.rows[0]);
        if (action.payloadHash !== actionPayloadHash) {
          throw new ConflictError(
            "The idempotency key is already bound to a different payload",
            { actionId: action.id },
          );
        }
        await client.query("COMMIT");
        return { action, replayed: true };
      }

      if (actionType === "deploy") {
        const binding = await client.query(
          "SELECT project_name FROM deployment_projects WHERE tenant_id = $1 FOR UPDATE",
          [tenantId],
        );
        if (binding.rowCount > 0 && binding.rows[0].project_name !== payload.projectName) {
          throw new ConflictError(
            "A tenant deployment is permanently bound to its existing project",
            { projectName: binding.rows[0].project_name },
          );
        }
        if (binding.rowCount === 0) {
          await client.query(
            `INSERT INTO deployment_projects (tenant_id, project_name)
             VALUES ($1, $2)`,
            [tenantId, payload.projectName],
          );
        }
      }

      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, status, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          actionId,
          tenantId,
          runId,
          agentName,
          actionType,
          actionPayloadHash,
          idempotencyKey,
          mode,
          approvalRequired ? "PENDING" : "NOT_REQUIRED",
          approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
          JSON.stringify(payload),
        ],
      );
      const action = await this.requireAction(actionId, client);
      await client.query("COMMIT");
      return { action, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("The action conflicts with an existing identity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async approveAction({
    actionId,
    payloadHash: approvedPayloadHash,
    approvedBy,
    tenantId,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM actions WHERE id = $1 FOR UPDATE",
        [actionId],
      );
      if (result.rowCount === 0) throw new NotFoundError(`Action ${actionId} was not found`);
      const action = parseAction(result.rows[0]);
      if (action.tenantId !== tenantId) {
        throw new ConflictError("Approval action does not belong to this tenant");
      }
      if (action.payloadHash !== approvedPayloadHash) {
        throw new ConflictError("Approval does not match the action payload hash", {
          actionId,
        });
      }
      if (
        action.status === "FAILED" &&
        action.failureMessage?.startsWith("Superseded by revision run ")
      ) {
        throw new ConflictError("This action was superseded by a newer revision");
      }
      if (action.actionType === "video-render") {
        const packApproval = await client.query(
          `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE approval_status = 'APPROVED')::int AS approved
           FROM marketing_artifacts
           WHERE tenant_id = $1 AND run_id = $2
             AND artifact_type NOT IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')`,
          [tenantId, action.runId],
        );
        if (
          Number(packApproval.rows[0].total) === 0 ||
          Number(packApproval.rows[0].approved) !== Number(packApproval.rows[0].total)
        ) {
          throw new ConflictError(
            "Marketing pack approval is required before video rendering",
          );
        }
      }
      if (action.status !== "EXECUTED" && action.approvalStatus !== "APPROVED") {
        await client.query(
          `UPDATE actions SET approval_status = 'APPROVED', approved_by = $2,
            approved_at = now(), status = 'APPROVED' WHERE id = $1`,
          [actionId, approvedBy],
        );
      }
      const updated = await this.requireAction(actionId, client);
      await client.query("COMMIT");
      return updated;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimForExecution(actionId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "SELECT * FROM actions WHERE id = $1 FOR UPDATE",
        [actionId],
      );
      if (result.rowCount === 0) throw new NotFoundError(`Action ${actionId} was not found`);
      const action = parseAction(result.rows[0]);
      if (action.status === "EXECUTED") {
        await client.query("COMMIT");
        return { action, claimed: false };
      }
      if (action.approvalStatus === "PENDING") {
        await client.query("COMMIT");
        return { action, claimed: false };
      }
      if (action.status === "EXECUTING") {
        const startedAt = action.executionStartedAt ?? action.createdAt;
        const stale = Number.isFinite(Date.parse(startedAt)) &&
          Date.parse(startedAt) <= Date.now() - STALE_EXECUTION_MS;
        if (!stale) {
          throw new ConflictError("The action is already executing", { actionId });
        }
        if (action.actionType === "video-render") {
          await client.query(
            `UPDATE actions SET status = 'FAILED', approval_status = 'PENDING',
              approved_by = NULL, approved_at = NULL, execution_started_at = NULL,
              failure_message = $2 WHERE id = $1`,
            [
              actionId,
              "A stale paid-video execution requires fresh administrator approval",
            ],
          );
          const recovered = await this.requireAction(actionId, client);
          await client.query("COMMIT");
          return { action: recovered, claimed: false, recovered: true };
        }
        await client.query(
          `UPDATE actions SET execution_started_at = now(), failure_message = NULL
           WHERE id = $1`,
          [actionId],
        );
        const recovered = await this.requireAction(actionId, client);
        await client.query("COMMIT");
        return { action: recovered, claimed: true, recovered: true };
      }
      await client.query(
        `UPDATE actions SET status = 'EXECUTING', execution_started_at = now(),
          failure_message = NULL WHERE id = $1`,
        [actionId],
      );
      const claimed = await this.requireAction(actionId, client);
      await client.query("COMMIT");
      return { action: claimed, claimed: true, recovered: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getPayload(actionId) {
    const result = await this.pool.query(
      "SELECT payload_json FROM actions WHERE id = $1",
      [actionId],
    );
    if (result.rowCount === 0 || !result.rows[0].payload_json) {
      throw new NotFoundError(`Payload for action ${actionId} was not found`);
    }
    return result.rows[0].payload_json;
  }

  async completeDeployment({
    actionId,
    tenantId,
    projectName,
    providerReference,
    providerCostMicrodollars,
    liveUrl,
    verifiedAt,
  }) {
    const siteHost = new URL(liveUrl).host.toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actionResult = await client.query(
        "SELECT * FROM actions WHERE id = $1 FOR UPDATE",
        [actionId],
      );
      if (actionResult.rowCount === 0) {
        throw new NotFoundError(`Action ${actionId} was not found`);
      }
      const approvedAction = parseAction(actionResult.rows[0]);
      if (
        approvedAction.tenantId !== tenantId ||
        approvedAction.actionType !== "deploy" ||
        approvedAction.approvalStatus !== "APPROVED" ||
        approvedAction.status !== "EXECUTING"
      ) {
        throw new ConflictError("Deployment completion does not match its approved action");
      }
      await client.query(
        `UPDATE actions SET status = 'EXECUTED', provider_reference = $2,
          provider_cost_microdollars = provider_cost_microdollars + $3,
          execution_started_at = NULL, executed_at = now(), failure_message = NULL
         WHERE id = $1`,
        [actionId, providerReference, providerCostMicrodollars],
      );
      await client.query(
        `INSERT INTO deployments (
          id, tenant_id, cloudflare_project_name, live_url,
          last_action_id, verified_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (tenant_id) DO UPDATE SET
          live_url = EXCLUDED.live_url,
          last_action_id = EXCLUDED.last_action_id,
          verified_at = EXCLUDED.verified_at,
          updated_at = now()`,
        [
          newId("deployment"),
          tenantId,
          projectName,
          liveUrl,
          actionId,
          verifiedAt,
        ],
      );
      await client.query(
        `INSERT INTO site_hosts (host, tenant_id) VALUES ($1, $2)
         ON CONFLICT (host) DO NOTHING`,
        [siteHost, tenantId],
      );
      const siteBinding = await client.query(
        "SELECT tenant_id FROM site_hosts WHERE host = $1",
        [siteHost],
      );
      if (siteBinding.rows[0]?.tenant_id !== tenantId) {
        throw new ConflictError("Deployment host is already bound to another tenant");
      }
      const completedTask = await client.query(
        `UPDATE tasks SET status = 'COMPLETE', output_ref = $2, updated_at = now()
         WHERE run_id = $1
           AND tenant_id = $3 AND task_type = 'WEB_BUILD'`,
        [approvedAction.runId, liveUrl, tenantId],
      );
      if (completedTask.rowCount !== 1) {
        throw new ConflictError("Deployment completion requires one matching WEB_BUILD task");
      }
      await client.query(
        `UPDATE runs SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1
           AND NOT EXISTS (
             SELECT 1 FROM tasks
             WHERE tasks.run_id = runs.id AND tasks.status <> 'COMPLETE'
           )`,
        [approvedAction.runId],
      );
      const action = await this.requireAction(actionId, client);
      await client.query("COMMIT");
      return action;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeVideoRender({
    actionId,
    tenantId,
    runId,
    brandDocumentId,
    outputs,
    providerCostMicrodollars,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actionResult = await client.query(
        "SELECT * FROM actions WHERE id = $1 FOR UPDATE",
        [actionId],
      );
      if (actionResult.rowCount === 0) throw new NotFoundError(`Action ${actionId} was not found`);
      const action = parseAction(actionResult.rows[0]);
      if (
        action.tenantId !== tenantId ||
        action.runId !== runId ||
        action.actionType !== "video-render" ||
        action.approvalStatus !== "APPROVED" ||
        action.status !== "EXECUTING"
      ) {
        throw new ConflictError("Video completion does not match its approved action");
      }
      for (const output of outputs) {
        await client.query(
          `INSERT INTO marketing_artifacts (
            id, tenant_id, run_id, brand_document_id, artifact_type,
            sequence_number, channel, r2_object_key, mime_type,
            self_review_status, grounding_check_status, review_feedback,
            approval_status, approved_by, approved_at
          ) VALUES (
            $1, $2, $3, $4, $5, 1, $6, $7, $8,
            'PASSED', 'PASSED', $9, 'APPROVED', $10, now()
          )`,
          [
            newId("artifact"),
            tenantId,
            runId,
            brandDocumentId,
            output.artifactType,
            output.variant,
            output.objectKey,
            output.mimeType,
            JSON.stringify({ contentHash: output.contentHash }),
            action.approvedBy,
          ],
        );
      }
      await client.query(
        `UPDATE marketing_artifacts SET approval_status = 'APPROVED',
          approved_by = $2, approved_at = now(), updated_at = now()
         WHERE run_id = $1 AND artifact_type = 'VIDEO_STORYBOARD'`,
        [runId, action.approvedBy],
      );
      const completedTask = await client.query(
        `UPDATE tasks SET status = 'COMPLETE', output_ref = $3, updated_at = now()
         WHERE run_id = $1 AND tenant_id = $2 AND task_type = 'MARKETING_PACK'`,
        [runId, tenantId, `video-render:${outputs.length}`],
      );
      if (completedTask.rowCount !== 1) {
        throw new ConflictError("Video completion requires one matching MARKETING_PACK task");
      }
      await client.query(
        `UPDATE runs SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1 AND NOT EXISTS (
           SELECT 1 FROM tasks
           WHERE tasks.run_id = runs.id AND tasks.status <> 'COMPLETE'
         )`,
        [runId],
      );
      await client.query(
        `UPDATE actions SET status = 'EXECUTED', provider_reference = $2,
          provider_cost_microdollars = provider_cost_microdollars + $3,
          execution_started_at = NULL,
          executed_at = now(), failure_message = NULL
         WHERE id = $1`,
        [
          actionId,
          JSON.stringify(outputs.map((output) => output.providerReference)),
          providerCostMicrodollars,
        ],
      );
      const completed = await this.requireAction(actionId, client);
      await client.query("COMMIT");
      return completed;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failAction(actionId, message) {
    await this.pool.query(
      `UPDATE actions SET status = 'FAILED', execution_started_at = NULL,
        failure_message = $2 WHERE id = $1`,
      [actionId, String(message).slice(0, 1000)],
    );
    return this.requireAction(actionId);
  }

  async failPaidAction({ actionId, message, providerCostMicrodollars }) {
    if (!Number.isSafeInteger(providerCostMicrodollars) || providerCostMicrodollars < 0) {
      throw new ValidationError("Paid-action cost must be a non-negative integer");
    }
    await this.pool.query(
      `UPDATE actions SET status = 'FAILED', approval_status = 'PENDING',
        approved_by = NULL, approved_at = NULL,
        execution_started_at = NULL,
        provider_cost_microdollars = provider_cost_microdollars + $2,
        failure_message = $3
       WHERE id = $1 AND action_type = 'video-render'`,
      [actionId, providerCostMicrodollars, String(message).slice(0, 1000)],
    );
    return this.requireAction(actionId);
  }

  async createRunShell({
    tenant,
    originalBrief,
    approvedBudgetMicrodollars,
    approvedBy,
    idempotencyKey,
    requestedBy = "orchestration-runtime",
  }) {
    const runShellPayloadHash = payloadHash({
      tenant,
      originalBrief,
      approvedBudgetMicrodollars,
      approvedBy,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenant.id}:onboarding:${idempotencyKey}`],
      );
      const existing = await client.query(
        `SELECT onboarding_requests.run_id, actions.payload_hash
         FROM onboarding_requests
         JOIN actions ON actions.run_id = onboarding_requests.run_id
           AND actions.action_type = 'create-run-shell'
           AND actions.idempotency_key = onboarding_requests.idempotency_key
         WHERE onboarding_requests.tenant_id = $1
           AND onboarding_requests.idempotency_key = $2`,
        [tenant.id, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].payload_hash !== runShellPayloadHash) {
          throw new ConflictError(
            "The onboarding idempotency key is bound to a different run shell",
          );
        }
        const result = await this.#readRun(client, existing.rows[0].run_id);
        await client.query("COMMIT");
        return { ...result, replayed: true };
      }

      await client.query(
        `INSERT INTO tenants (
          id, name, email, business_name, business_slug,
          business_email, business_phone, business_address
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO NOTHING`,
        [
          tenant.id,
          tenant.name,
          tenant.email,
          tenant.businessName,
          tenant.businessSlug,
          tenant.businessEmail,
          tenant.businessPhone,
          tenant.businessAddress,
        ],
      );
      const persistedTenant = await client.query(
        `SELECT business_slug, business_name, business_email,
          business_phone, business_address
         FROM tenants WHERE id = $1 FOR UPDATE`,
        [tenant.id],
      );
      if (persistedTenant.rowCount === 0) {
        throw new NotFoundError(`Tenant ${tenant.id} could not be persisted`);
      }
      if (
        persistedTenant.rows[0].business_slug !== tenant.businessSlug ||
        persistedTenant.rows[0].business_name !== tenant.businessName ||
        persistedTenant.rows[0].business_email !== tenant.businessEmail ||
        persistedTenant.rows[0].business_phone !== tenant.businessPhone ||
        persistedTenant.rows[0].business_address !== tenant.businessAddress
      ) {
        throw new ConflictError(
          "Tenant identity is already bound to different business details",
        );
      }

      const runId = newId("run");
      const executingDownstream = await client.query(
        `SELECT id FROM actions
         WHERE tenant_id = $1 AND action_type IN ('deploy', 'video-render')
           AND status = 'EXECUTING' LIMIT 1`,
        [tenant.id],
      );
      if (executingDownstream.rowCount > 0) {
        throw new ConflictError(
          "Wait for the current deployment or video action to finish before starting a new strategy run",
        );
      }
      await client.query(
        `UPDATE actions SET status = 'FAILED',
          failure_message = $2, execution_started_at = NULL
         WHERE tenant_id = $1 AND action_type IN ('deploy', 'video-render')
           AND status <> 'EXECUTED'`,
        [tenant.id, `Superseded by revision run ${runId}`],
      );
      await client.query(
        `UPDATE marketing_artifacts SET approval_status = 'REJECTED',
          updated_at = now()
         WHERE tenant_id = $1 AND approval_status = 'PENDING'`,
        [tenant.id],
      );
      await client.query(
        `UPDATE runs SET status = 'SUPERSEDED'
         WHERE tenant_id = $1
           AND status IN ('CREATED', 'AWAITING_BRAND_APPROVAL', 'EXECUTING')`,
        [tenant.id],
      );
      await client.query(
        `INSERT INTO runs (
          id, tenant_id, original_brief, brief_hash,
          approved_budget_microdollars, budget_approved_by, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'CREATED')`,
        [
          runId,
          tenant.id,
          originalBrief,
          sha256(originalBrief),
          approvedBudgetMicrodollars,
          approvedBy,
        ],
      );
      await client.query(
        `INSERT INTO onboarding_requests (
          id, tenant_id, idempotency_key, run_id
        ) VALUES ($1, $2, $3, $4)`,
        [newId("onboarding"), tenant.id, idempotencyKey, runId],
      );
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type,
          payload_hash, idempotency_key, mode, approval_status,
          approved_by, approved_at, provider_cost_microdollars, status, executed_at
        ) VALUES (
          $1, $2, $3, $4, 'create-run-shell',
          $5, $6, 'TEST', 'APPROVED', $7, now(), 0, 'EXECUTED', now()
        )`,
        [
          actionId,
          tenant.id,
          runId,
          requestedBy,
          runShellPayloadHash,
          idempotencyKey,
          approvedBy,
        ],
      );
      await client.query("COMMIT");
      return {
        tenantId: tenant.id,
        runId,
        status: "CREATED",
        brandDocumentId: null,
        tasks: [],
        actionId,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Onboarding conflicts with an existing unique identity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createArtifactRevision({
    tenantId,
    sourceRunId,
    artifactType,
    feedback,
    approvedBudgetMicrodollars,
    approvedBy,
    idempotencyKey,
  }) {
    const revisionHash = payloadHash({
      sourceRunId,
      artifactType,
      feedback,
      approvedBudgetMicrodollars,
      approvedBy,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:artifact-revision:${idempotencyKey}`,
      ]);
      const existing = await client.query(
        `SELECT id, run_id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'create-artifact-revision'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].payload_hash !== revisionHash) {
          throw new ConflictError(
            "The artifact revision identity is bound to different feedback",
          );
        }
        await client.query("COMMIT");
        return {
          tenantId,
          sourceRunId,
          runId: existing.rows[0].run_id,
          artifactType,
          actionId: existing.rows[0].id,
          replayed: true,
        };
      }
      const source = await client.query(
        `SELECT runs.original_brief, runs.completed_brief, runs.brand_document_id,
          brand_documents.approval_status
         FROM runs
         JOIN brand_documents ON brand_documents.id = runs.brand_document_id
         WHERE runs.id = $1 AND runs.tenant_id = $2
         FOR SHARE OF runs, brand_documents`,
        [sourceRunId, tenantId],
      );
      if (source.rowCount === 0) {
        throw new NotFoundError("The source run or brand document was not found");
      }
      if (source.rows[0].approval_status !== "APPROVED") {
        throw new ConflictError("Artifact revisions require an approved brand document");
      }
      const supersededActionType = artifactType === "WEB_BUILD" ? "deploy" : "video-render";
      const executing = await client.query(
        `SELECT id FROM actions
         WHERE tenant_id = $1 AND run_id = $2 AND action_type = $3
           AND status = 'EXECUTING' LIMIT 1`,
        [tenantId, sourceRunId, supersededActionType],
      );
      if (executing.rowCount > 0) {
        throw new ConflictError(
          `Wait for the current ${artifactType.toLowerCase()} action to finish before revising`,
        );
      }
      const runId = newId("run");
      const revisionBrief = `${source.rows[0].original_brief}\n\n${artifactType} revision request:\n${feedback}`;
      await client.query(
        `INSERT INTO runs (
          id, tenant_id, original_brief, completed_brief, brief_hash,
          brand_document_id, approved_budget_microdollars,
          budget_approved_by, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EXECUTING')`,
        [
          runId,
          tenantId,
          revisionBrief,
          source.rows[0].completed_brief,
          sha256(revisionBrief),
          source.rows[0].brand_document_id,
          approvedBudgetMicrodollars,
          approvedBy,
        ],
      );
      await client.query(
        `INSERT INTO tasks (id, tenant_id, run_id, task_type, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [newId("task"), tenantId, runId, artifactType],
      );
      await client.query(
        `UPDATE actions SET status = 'FAILED',
          failure_message = $4, execution_started_at = NULL
         WHERE tenant_id = $1 AND run_id = $2 AND action_type = $3
           AND status <> 'EXECUTED'`,
        [
          tenantId,
          sourceRunId,
          supersededActionType,
          `Superseded by revision run ${runId}`,
        ],
      );
      if (artifactType === "MARKETING_PACK") {
        await client.query(
          `UPDATE marketing_artifacts SET approval_status = 'REJECTED',
            updated_at = now()
           WHERE tenant_id = $1 AND run_id = $2 AND approval_status = 'PENDING'`,
          [tenantId, sourceRunId],
        );
      }
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, approved_by, approved_at,
          provider_cost_microdollars, status, payload_json, executed_at
        ) VALUES (
          $1, $2, $3, 'admin', 'create-artifact-revision', $4,
          $5, 'TEST', 'APPROVED', $6, now(), 0, 'EXECUTED', $7::jsonb, now()
        )`,
        [
          actionId,
          tenantId,
          runId,
          revisionHash,
          idempotencyKey,
          approvedBy,
          JSON.stringify({ sourceRunId, artifactType, feedback }),
        ],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        sourceRunId,
        runId,
        artifactType,
        actionId,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Artifact revision conflicts with an existing identity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeRun({
    tenantId,
    runId,
    completedBrief,
    brandDocument,
    taskPlan,
    idempotencyKey,
    agentName = "ops",
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${tenantId}:finalize:${runId}`],
      );
      const runResult = await client.query(
        `SELECT tenant_id, brand_document_id, status FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (runResult.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (runResult.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the requested tenant");
      }

      const actionHash = payloadHash({ completedBrief, brandDocument, taskPlan });
      const existingAction = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'finalize-run' AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existingAction.rowCount > 0) {
        if (existingAction.rows[0].payload_hash !== actionHash) {
          throw new ConflictError(
            "The finalization idempotency key is bound to different outputs",
          );
        }
        const existing = await this.#readRun(client, runId);
        await client.query("COMMIT");
        return { ...existing, actionId: existingAction.rows[0].id, replayed: true };
      }
      if (runResult.rows[0].status !== "CREATED") {
        throw new ConflictError(`Run ${runId} cannot be finalized from its current state`);
      }

      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version
         FROM brand_documents WHERE tenant_id = $1`,
        [tenantId],
      );
      const versionNumber = Number(versionResult.rows[0].next_version);
      const brandDocumentId = newId("brand");
      const brandDocumentHash = sha256(brandDocument);
      await client.query(
        `INSERT INTO brand_documents (
          id, tenant_id, version_number, full_text, content_hash, approval_status
        ) VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
        [brandDocumentId, tenantId, versionNumber, brandDocument, brandDocumentHash],
      );

      const tasks = [];
      for (const task of taskPlan) {
        const taskId = newId("task");
        await client.query(
          `INSERT INTO tasks (id, tenant_id, run_id, task_type, status)
           VALUES ($1, $2, $3, $4, 'PENDING')`,
          [taskId, tenantId, runId, task.taskType],
        );
        tasks.push({ id: taskId, taskType: task.taskType, status: "PENDING" });
      }
      await client.query(
        `UPDATE runs SET completed_brief = $1, brand_document_id = $2,
          status = 'AWAITING_BRAND_APPROVAL' WHERE id = $3`,
        [completedBrief, brandDocumentId, runId],
      );
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type,
          payload_hash, idempotency_key, mode, approval_status,
          provider_cost_microdollars, status, executed_at
        ) VALUES (
          $1, $2, $3, $4, 'finalize-run', $5, $6,
          'TEST', 'NOT_REQUIRED', 0, 'EXECUTED', now()
        )`,
        [actionId, tenantId, runId, agentName, actionHash, idempotencyKey],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        runId,
        status: "AWAITING_BRAND_APPROVAL",
        brandDocumentId,
        brandVersion: versionNumber,
        brandDocumentHash,
        brandApprovalStatus: "PENDING",
        tasks,
        actionId,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Finalization conflicts with an existing record");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async approveBrandDocument({
    tenantId,
    runId,
    brandDocumentId,
    contentHash,
    approvedBy,
    idempotencyKey,
  }) {
    const approvalHash = payloadHash({ brandDocumentId, contentHash });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:brand-approval:${runId}`,
      ]);
      const brand = await client.query(
        `SELECT brand_documents.full_text, brand_documents.content_hash,
          brand_documents.approval_status, runs.status
         FROM runs
         JOIN brand_documents ON brand_documents.id = runs.brand_document_id
         WHERE runs.id = $1 AND runs.tenant_id = $2
           AND brand_documents.id = $3
         FOR UPDATE OF runs, brand_documents`,
        [runId, tenantId, brandDocumentId],
      );
      if (brand.rowCount === 0) {
        throw new NotFoundError("The brand document does not belong to this run");
      }
      const persistedHash = brand.rows[0].content_hash ?? sha256(brand.rows[0].full_text);
      if (persistedHash !== contentHash) {
        throw new ConflictError("Brand approval does not match the displayed document");
      }
      if (brand.rows[0].status === "SUPERSEDED") {
        throw new ConflictError("This brand document was superseded by a newer revision");
      }
      const existing = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'approve-brand-document'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0 && existing.rows[0].payload_hash !== approvalHash) {
        throw new ConflictError("Brand approval identity is bound to another document");
      }
      await client.query(
        `UPDATE brand_documents SET content_hash = $2, approval_status = 'APPROVED',
          approved_by = COALESCE(approved_by, $3),
          approved_at = COALESCE(approved_at, now())
         WHERE id = $1`,
        [brandDocumentId, contentHash, approvedBy],
      );
      await client.query(
        `UPDATE runs SET status = CASE
          WHEN status = 'AWAITING_BRAND_APPROVAL' THEN 'EXECUTING'
          ELSE status END
         WHERE id = $1 AND tenant_id = $2`,
        [runId, tenantId],
      );
      let actionId = existing.rows[0]?.id;
      if (!actionId) {
        actionId = newId("action");
        await client.query(
          `INSERT INTO actions (
            id, tenant_id, run_id, agent_name, action_type, payload_hash,
            idempotency_key, mode, approval_status, approved_by, approved_at,
            provider_cost_microdollars, status, payload_json, executed_at
          ) VALUES (
            $1, $2, $3, 'admin', 'approve-brand-document', $4,
            $5, 'TEST', 'APPROVED', $6, now(), 0, 'EXECUTED', $7::jsonb, now()
          )`,
          [
            actionId,
            tenantId,
            runId,
            approvalHash,
            idempotencyKey,
            approvedBy,
            JSON.stringify({ brandDocumentId, contentHash }),
          ],
        );
      }
      const approved = await client.query(
        `SELECT approval_status, approved_by, approved_at
         FROM brand_documents WHERE id = $1`,
        [brandDocumentId],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        runId,
        brandDocumentId,
        contentHash,
        approvalStatus: approved.rows[0].approval_status,
        approvedBy: approved.rows[0].approved_by,
        approvedAt:
          approved.rows[0].approved_at?.toISOString?.() ?? approved.rows[0].approved_at,
        actionId,
        replayed: existing.rowCount > 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistCatalog({
    tenantId,
    runId,
    items,
    idempotencyKey,
    agentName,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:catalog:${idempotencyKey}`,
      ]);
      const run = await client.query(
        "SELECT tenant_id FROM runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the catalog tenant");
      }
      const actionHash = payloadHash({ items });
      const existing = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'persist-catalog'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].payload_hash !== actionHash) {
          throw new ConflictError(
            "The catalog idempotency key is bound to a different catalog",
          );
        }
        const rows = await client.query(
          `SELECT id, item_key, name, description, available_quantity,
            day_rate_cents, currency
           FROM rental_items WHERE tenant_id = $1 ORDER BY item_key`,
          [tenantId],
        );
        await client.query("COMMIT");
        return {
          actionId: existing.rows[0].id,
          tenantId,
          runId,
          items: rows.rows.map((item) => ({
            id: item.id,
            itemKey: item.item_key,
            name: item.name,
            description: item.description,
            availableQuantity: Number(item.available_quantity),
            dayRateCents: Number(item.day_rate_cents),
            currency: item.currency,
          })),
          replayed: true,
        };
      }

      const persisted = [];
      for (const item of items) {
        const itemId = `item_${sha256(`${tenantId}:${item.itemKey}`).slice(0, 24)}`;
        const result = await client.query(
          `INSERT INTO rental_items (
            id, tenant_id, item_key, name, description,
            available_quantity, day_rate_cents, currency
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (tenant_id, item_key) WHERE item_key IS NOT NULL DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            available_quantity = EXCLUDED.available_quantity,
            day_rate_cents = EXCLUDED.day_rate_cents,
            currency = EXCLUDED.currency,
            active = true,
            updated_at = now()
          RETURNING id, item_key, name, description, available_quantity,
            day_rate_cents, currency`,
          [
            itemId,
            tenantId,
            item.itemKey,
            item.name,
            item.description,
            item.availableQuantity,
            item.dayRateCents,
            item.currency,
          ],
        );
        const row = result.rows[0];
        persisted.push({
          id: row.id,
          itemKey: row.item_key,
          name: row.name,
          description: row.description,
          availableQuantity: Number(row.available_quantity),
          dayRateCents: Number(row.day_rate_cents),
          currency: row.currency,
        });
      }
      const completedTask = await client.query(
        `UPDATE tasks SET status = 'COMPLETE', output_ref = $3, updated_at = now()
         WHERE run_id = $1 AND tenant_id = $2 AND task_type = 'CATALOG_PERSIST'`,
        [runId, tenantId, `catalog:${persisted.length}`],
      );
      if (completedTask.rowCount !== 1) {
        throw new ConflictError("Catalog persistence requires one matching CATALOG_PERSIST task");
      }
      await client.query(
        `UPDATE runs SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1 AND NOT EXISTS (
           SELECT 1 FROM tasks
           WHERE tasks.run_id = runs.id AND tasks.status <> 'COMPLETE'
         )`,
        [runId],
      );
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, provider_cost_microdollars,
          status, payload_json, executed_at
        ) VALUES (
          $1, $2, $3, $4, 'persist-catalog', $5, $6,
          'TEST', 'NOT_REQUIRED', 0, 'EXECUTED', $7::jsonb, now()
        )`,
        [
          actionId,
          tenantId,
          runId,
          agentName,
          actionHash,
          idempotencyKey,
          JSON.stringify({ items }),
        ],
      );
      await client.query("COMMIT");
      return { actionId, tenantId, runId, items: persisted, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Catalog conflicts with an existing identity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async readRunContext({ tenantId, runId }) {
    const result = await this.pool.query(
      `SELECT runs.completed_brief, runs.status, runs.brand_document_id,
        brand_documents.version_number, brand_documents.full_text,
        brand_documents.content_hash, brand_documents.approval_status,
        brand_documents.approved_by, brand_documents.approved_at,
        tenants.business_name, tenants.business_slug, tenants.business_email,
        tenants.business_phone, tenants.business_address
       FROM runs
       JOIN tenants ON tenants.id = runs.tenant_id
       LEFT JOIN brand_documents ON brand_documents.id = runs.brand_document_id
       WHERE runs.id = $1 AND runs.tenant_id = $2`,
      [runId, tenantId],
    );
    if (result.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
    if (!result.rows[0].brand_document_id) {
      throw new ConflictError("Run context is unavailable until finalization completes");
    }
    const [catalog, tasks] = await Promise.all([
      this.pool.query(
        `SELECT id, item_key, name, description, available_quantity,
          day_rate_cents, currency
         FROM rental_items WHERE tenant_id = $1 AND active = true ORDER BY item_key`,
        [tenantId],
      ),
      this.pool.query(
        `SELECT id, task_type, status, output_ref FROM tasks
         WHERE run_id = $1 ORDER BY task_type`,
        [runId],
      ),
    ]);
    const row = result.rows[0];
    return {
      tenantId,
      runId,
      runStatus: row.status,
      completedBrief: row.completed_brief,
      brandDocument: {
        id: row.brand_document_id,
        version: Number(row.version_number),
        fullText: row.full_text,
        contentHash: row.content_hash ?? sha256(row.full_text),
        approvalStatus: row.approval_status,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at?.toISOString?.() ?? row.approved_at,
      },
      business: {
        name: row.business_name,
        slug: row.business_slug,
        email: row.business_email,
        phone: row.business_phone,
        address: row.business_address,
      },
      catalog: catalog.rows.map((item) => ({
        id: item.id,
        itemKey: item.item_key,
        name: item.name,
        description: item.description,
        availableQuantity: Number(item.available_quantity),
        dayRateCents: Number(item.day_rate_cents),
        currency: item.currency,
      })),
      tasks: tasks.rows.map((task) => ({
        id: task.id,
        taskType: task.task_type,
        status: task.status,
        outputRef: task.output_ref,
      })),
    };
  }

  async readRunDeliverables({ tenantId, runId }) {
    const run = await this.pool.query(
      "SELECT 1 FROM runs WHERE id = $1 AND tenant_id = $2",
      [runId, tenantId],
    );
    if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
    const [siteArtifact, deployAction, marketingAction, videoAction, marketingState] =
      await Promise.all([
        this.pool.query(
          `SELECT html_content, content_hash, revision_number
           FROM site_artifacts
           WHERE run_id = $1 AND tenant_id = $2
           ORDER BY revision_number DESC LIMIT 1`,
          [runId, tenantId],
        ),
        this.pool.query(
          `SELECT * FROM actions
           WHERE run_id = $1 AND tenant_id = $2 AND action_type = 'deploy'
           ORDER BY created_at DESC LIMIT 1`,
          [runId, tenantId],
        ),
        this.pool.query(
          `SELECT payload_hash, payload_json FROM actions
           WHERE run_id = $1 AND tenant_id = $2
             AND action_type = 'persist-marketing-pack' AND status = 'EXECUTED'
           ORDER BY created_at DESC LIMIT 1`,
          [runId, tenantId],
        ),
        this.pool.query(
          `SELECT * FROM actions
           WHERE run_id = $1 AND tenant_id = $2 AND action_type = 'video-render'
           ORDER BY created_at DESC LIMIT 1`,
          [runId, tenantId],
        ),
        this.pool.query(
          `SELECT CASE
             WHEN COUNT(*) = 0 THEN NULL
             WHEN BOOL_AND(approval_status = 'APPROVED') THEN 'APPROVED'
             WHEN BOOL_AND(approval_status = 'REJECTED') THEN 'REJECTED'
             ELSE 'PENDING'
           END AS approval_status
           FROM marketing_artifacts WHERE run_id = $1 AND tenant_id = $2`,
          [runId, tenantId],
        ),
      ]);
    const site = siteArtifact.rows[0];
    const deployment = parseAction(deployAction.rows[0]);
    const marketing = marketingAction.rows[0];
    return {
      runId,
      website: site && deployment
        ? {
            draft: { html: site.html_content },
            persisted: {
              contentHash: site.content_hash,
              revisionNumber: Number(site.revision_number),
            },
            deployment: { action: deployment },
          }
        : null,
      marketing: marketing
        ? {
            pack: marketing.payload_json.pack,
            persisted: {
              packHash: marketing.payload_hash,
              videoAction: parseAction(videoAction.rows[0]),
              approvalStatus: marketingState.rows[0]?.approval_status ?? "PENDING",
            },
          }
        : null,
    };
  }

  async readTenantProfile({ tenantId }) {
    const result = await this.pool.query(
      `SELECT id, business_name, business_slug, business_email,
        business_phone, business_address,
        (SELECT runs.id FROM runs WHERE runs.tenant_id = tenants.id
         ORDER BY runs.created_at DESC LIMIT 1) AS latest_run_id
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (result.rowCount === 0) return null;
    const tenant = result.rows[0];
    const profile = {
      tenantId: tenant.id,
      businessName: tenant.business_name,
      businessSlug: tenant.business_slug,
      businessEmail: tenant.business_email,
      businessPhone: tenant.business_phone,
      businessAddress: tenant.business_address,
    };
    if (tenant.latest_run_id) profile.latestRunId = tenant.latest_run_id;
    return profile;
  }

  async readErasureManifest({ tenantId }) {
    const tenant = await this.pool.query(
      "SELECT id FROM tenants WHERE id = $1",
      [tenantId],
    );
    if (tenant.rowCount === 0) return null;
    const [deployment, sessions] = await Promise.all([
      this.pool.query(
        `SELECT project.project_name, deployment.live_url
         FROM deployment_projects AS project
         LEFT JOIN deployments AS deployment ON deployment.tenant_id = project.tenant_id
         WHERE project.tenant_id = $1`,
        [tenantId],
      ),
      this.pool.query(
        `SELECT stripe_checkout_session_id
         FROM reservations
         WHERE tenant_id = $1 AND stripe_checkout_session_id IS NOT NULL`,
        [tenantId],
      ),
    ]);
    return {
      tenantId,
      projectName: deployment.rows[0]?.project_name ?? null,
      liveUrl: deployment.rows[0]?.live_url ?? null,
      r2Prefix: `epyhia-demo/${tenantId}/`,
      stripeCheckoutSessionIds: sessions.rows.map(
        (row) => row.stripe_checkout_session_id,
      ),
    };
  }

  async deleteTenantData({ tenantId }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `erase:${tenantId}`,
      ]);
      const tenant = await client.query(
        "SELECT id FROM tenants WHERE id = $1 FOR UPDATE",
        [tenantId],
      );
      if (tenant.rowCount === 0) {
        await client.query("COMMIT");
        return { tenantId, deleted: false, alreadyDeleted: true };
      }
      const statements = [
        "DELETE FROM deployments WHERE tenant_id = $1",
        "DELETE FROM marketing_artifacts WHERE tenant_id = $1",
        "DELETE FROM site_artifacts WHERE tenant_id = $1",
        "DELETE FROM orders WHERE tenant_id = $1",
        `DELETE FROM reservation_items WHERE reservation_id IN
          (SELECT id FROM reservations WHERE tenant_id = $1)`,
        "DELETE FROM reservations WHERE tenant_id = $1",
        "DELETE FROM customers WHERE tenant_id = $1",
        "DELETE FROM rental_items WHERE tenant_id = $1",
        "DELETE FROM site_hosts WHERE tenant_id = $1",
        "DELETE FROM webhook_events WHERE tenant_id = $1",
        "DELETE FROM deployment_projects WHERE tenant_id = $1",
        "DELETE FROM actions WHERE tenant_id = $1",
        `DELETE FROM agent_calls WHERE run_id IN
          (SELECT id FROM runs WHERE tenant_id = $1)`,
        "DELETE FROM onboarding_requests WHERE tenant_id = $1",
        "DELETE FROM tasks WHERE tenant_id = $1",
        "DELETE FROM runs WHERE tenant_id = $1",
        "DELETE FROM brand_documents WHERE tenant_id = $1",
        "DELETE FROM tenants WHERE id = $1",
      ];
      let deletedRows = 0;
      for (const sql of statements) {
        const result = await client.query(sql, [tenantId]);
        deletedRows += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { tenantId, deleted: true, alreadyDeleted: false, deletedRows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readRunAudit({ tenantId, runId }) {
    const run = await this.pool.query(
      `SELECT id, status, approved_budget_microdollars
       FROM runs WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
    const [calls, actions, costs, evidence] = await Promise.all([
      this.pool.query(
        `SELECT id, agent_name, model_id, model_tier, input_tokens,
          cached_input_tokens, output_tokens, cost_microdollars, status,
          started_at, completed_at
         FROM agent_calls WHERE run_id = $1 ORDER BY started_at`,
        [runId],
      ),
      this.pool.query(
        `SELECT id, agent_name, action_type, mode, approval_status,
          approved_by, payload_hash, provider_cost_microdollars, status,
          failure_message, created_at, execution_started_at, executed_at
         FROM actions WHERE run_id = $1 ORDER BY created_at`,
        [runId],
      ),
      this.pool.query(
        `SELECT
          COALESCE((SELECT SUM(cost_microdollars) FROM agent_calls
            WHERE run_id = $1), 0) AS model_cost,
          COALESCE((SELECT SUM(provider_cost_microdollars) FROM actions
            WHERE run_id = $1), 0) AS provider_cost`,
        [runId],
      ),
      this.pool.query(
        `SELECT
          (SELECT COUNT(*) FROM deployments WHERE tenant_id = $1) AS deployment_count,
          (SELECT COUNT(*) FROM site_artifacts WHERE run_id = $2) AS site_artifact_count,
          (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND status = 'PAID')
            AS paid_order_count,
          (SELECT COUNT(*) FROM (
            SELECT reservation_id FROM orders WHERE tenant_id = $1
            GROUP BY reservation_id HAVING COUNT(*) > 1
          ) duplicate_reservations) AS duplicate_order_groups,
          (SELECT cloudflare_project_name FROM deployments
            WHERE tenant_id = $1 LIMIT 1) AS project_name,
          (SELECT live_url FROM deployments
            WHERE tenant_id = $1 LIMIT 1) AS live_url,
          (SELECT last_action_id FROM deployments
            WHERE tenant_id = $1 LIMIT 1) AS deployment_action_id,
          ARRAY(SELECT id FROM orders WHERE tenant_id = $1 AND status = 'PAID'
            ORDER BY created_at) AS order_ids`,
        [tenantId, runId],
      ),
    ]);
    const modelCostMicrodollars = Number(costs.rows[0].model_cost);
    const providerCostMicrodollars = Number(costs.rows[0].provider_cost);
    return {
      runId,
      tenantId,
      status: run.rows[0].status,
      approvedBudgetMicrodollars: Number(run.rows[0].approved_budget_microdollars),
      costs: {
        modelCostMicrodollars,
        providerCostMicrodollars,
        totalCostMicrodollars: modelCostMicrodollars + providerCostMicrodollars,
      },
      idempotencyEvidence: {
        deploymentCount: Number(evidence.rows[0].deployment_count),
        siteArtifactCount: Number(evidence.rows[0].site_artifact_count),
        paidOrderCount: Number(evidence.rows[0].paid_order_count),
        duplicateOrderGroups: Number(evidence.rows[0].duplicate_order_groups),
        projectName: evidence.rows[0].project_name,
        liveUrl: evidence.rows[0].live_url,
        deploymentActionId: evidence.rows[0].deployment_action_id,
        orderIds: evidence.rows[0].order_ids ?? [],
      },
      modelCalls: calls.rows.map((call) => ({
        id: call.id,
        agentName: call.agent_name,
        modelId: call.model_id,
        modelTier: call.model_tier,
        inputTokens: Number(call.input_tokens),
        cachedInputTokens: Number(call.cached_input_tokens),
        outputTokens: Number(call.output_tokens),
        costMicrodollars: Number(call.cost_microdollars),
        status: call.status,
        startedAt: call.started_at?.toISOString?.() ?? call.started_at,
        completedAt: call.completed_at?.toISOString?.() ?? call.completed_at,
      })),
      actions: actions.rows.map((action) => ({
        id: action.id,
        agentName: action.agent_name,
        actionType: action.action_type,
        mode: action.mode,
        approvalStatus: action.approval_status,
        approvedBy: action.approved_by,
        payloadHash: action.payload_hash,
        providerCostMicrodollars: Number(action.provider_cost_microdollars),
        status: action.status,
        failureMessage: action.failure_message,
        createdAt: action.created_at?.toISOString?.() ?? action.created_at,
        executionStartedAt:
          action.execution_started_at?.toISOString?.() ?? action.execution_started_at,
        executedAt: action.executed_at?.toISOString?.() ?? action.executed_at,
      })),
    };
  }

  async persistMarketingPack({
    tenantId,
    runId,
    pack,
    review,
    idempotencyKey,
    agentName,
  }) {
    const actionHash = payloadHash({ pack, review });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:marketing:${idempotencyKey}`,
      ]);
      const run = await client.query(
        `SELECT tenant_id, brand_document_id FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the marketing tenant");
      }
      const brandDocumentId = run.rows[0].brand_document_id;
      if (!brandDocumentId) {
        throw new ConflictError("Marketing pack requires a finalized brand document");
      }
      const existing = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'persist-marketing-pack'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].payload_hash !== actionHash) {
          throw new ConflictError(
            "The marketing idempotency key is bound to a different pack",
          );
        }
        const artifacts = await client.query(
          `SELECT id, artifact_type, sequence_number, channel, text_content,
            approval_status FROM marketing_artifacts
           WHERE run_id = $1 ORDER BY artifact_type, sequence_number`,
          [runId],
        );
        const videoAction = await client.query(
          `SELECT * FROM actions WHERE tenant_id = $1 AND run_id = $2
           AND action_type = 'video-render' AND idempotency_key = $3`,
          [tenantId, runId, `${idempotencyKey}:video`],
        );
        await client.query("COMMIT");
        return {
          actionId: existing.rows[0].id,
          packHash: actionHash,
          artifacts: artifacts.rows,
          videoAction: parseAction(videoAction.rows[0]),
          replayed: true,
        };
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:video-limit`,
      ]);
      const priorVideoActions = await client.query(
        `SELECT COUNT(*) AS count FROM actions
         WHERE tenant_id = $1 AND action_type = 'video-render'`,
        [tenantId],
      );
      if (Number(priorVideoActions.rows[0].count) >= 5) {
        throw new ConflictError("The tenant has reached the five-render video limit");
      }

      const artifactInputs = [
        {
          type: "LANDING_COPY",
          sequence: 1,
          channel: "website",
          text: pack.landingCopy,
          approval: "PENDING",
        },
        ...pack.socialPosts.map((post, index) => ({
          type: "SOCIAL_POST",
          sequence: index + 1,
          channel: post.channel,
          text: post.text,
          approval: "PENDING",
        })),
        {
          type: "LAUNCH_EMAIL",
          sequence: 1,
          channel: "email-draft",
          text: pack.launchEmail,
          approval: "PENDING",
        },
        {
          type: "VIDEO_STORYBOARD",
          sequence: 1,
          channel: "video",
          text: JSON.stringify(pack.storyboard),
          approval: "PENDING",
        },
      ];
      const artifacts = [];
      for (const artifact of artifactInputs) {
        const artifactId = newId("artifact");
        const persisted = await client.query(
          `INSERT INTO marketing_artifacts (
            id, tenant_id, run_id, brand_document_id, artifact_type,
            sequence_number, channel, text_content, self_review_status,
            grounding_check_status, review_feedback, approval_status
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            'PASSED', 'PASSED', $9, $10
          ) RETURNING id, artifact_type, sequence_number, channel,
            text_content, approval_status`,
          [
            artifactId,
            tenantId,
            runId,
            brandDocumentId,
            artifact.type,
            artifact.sequence,
            artifact.channel,
            artifact.text,
            JSON.stringify(review),
            artifact.approval,
          ],
        );
        artifacts.push(persisted.rows[0]);
      }
      await client.query(
        `UPDATE tasks SET status = 'AWAITING_MARKETING_APPROVAL',
          output_ref = $3, updated_at = now()
         WHERE run_id = $1 AND tenant_id = $2 AND task_type = 'MARKETING_PACK'`,
        [runId, tenantId, `marketing-pack:${artifacts.length}`],
      );
      const videoPayload = {
        brandDocumentId,
        model: "veo-3.1-fast-generate-001",
        durationSeconds: 4,
        resolution: "720p",
        generateAudio: false,
        estimatedCostMicrodollars: 640_000,
        outputs: [
          {
            variant: "landscape",
            artifactType: "VIDEO_LANDSCAPE",
            aspectRatio: "16:9",
            prompt: pack.storyboard.landscapePrompt,
          },
          {
            variant: "vertical",
            artifactType: "VIDEO_VERTICAL",
            aspectRatio: "9:16",
            prompt: pack.storyboard.verticalPrompt,
          },
        ],
      };
      const videoActionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, provider_cost_microdollars,
          status, payload_json
        ) VALUES (
          $1, $2, $3, $4, 'video-render', $5, $6,
          'LIVE', 'PENDING', 0, 'PENDING_APPROVAL', $7::jsonb
        )`,
        [
          videoActionId,
          tenantId,
          runId,
          agentName,
          payloadHash(videoPayload),
          `${idempotencyKey}:video`,
          JSON.stringify(videoPayload),
        ],
      );
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, provider_cost_microdollars,
          status, payload_json, executed_at
        ) VALUES (
          $1, $2, $3, $4, 'persist-marketing-pack', $5, $6,
          'TEST', 'NOT_REQUIRED', 0, 'EXECUTED', $7::jsonb, now()
        )`,
        [
          actionId,
          tenantId,
          runId,
          agentName,
          actionHash,
          idempotencyKey,
          JSON.stringify({ pack, review }),
        ],
      );
      const videoAction = await this.requireAction(videoActionId, client);
      await client.query("COMMIT");
      return { actionId, packHash: actionHash, artifacts, videoAction, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Marketing pack conflicts with an existing artifact");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async approveMarketingPack({
    tenantId,
    runId,
    packHash,
    approvedBy,
    idempotencyKey,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:marketing-approval:${runId}`,
      ]);
      const persisted = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND run_id = $2
           AND action_type = 'persist-marketing-pack'
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [tenantId, runId],
      );
      if (persisted.rowCount === 0) {
        throw new NotFoundError("The marketing pack has not been generated");
      }
      if (persisted.rows[0].payload_hash !== packHash) {
        throw new ConflictError("Marketing approval does not match the displayed pack");
      }
      const artifacts = await client.query(
        `SELECT id, approval_status FROM marketing_artifacts
         WHERE tenant_id = $1 AND run_id = $2
           AND artifact_type NOT IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')
         FOR UPDATE`,
        [tenantId, runId],
      );
      if (artifacts.rowCount === 0) {
        throw new NotFoundError("The marketing pack has no reviewable artifacts");
      }
      if (artifacts.rows.some((artifact) => artifact.approval_status === "REJECTED")) {
        throw new ConflictError("This marketing pack was superseded by a newer revision");
      }
      const existing = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'approve-marketing-pack'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0 && existing.rows[0].payload_hash !== packHash) {
        throw new ConflictError("Marketing approval identity is bound to another pack");
      }
      await client.query(
        `UPDATE marketing_artifacts
         SET approval_status = 'APPROVED',
           approved_by = COALESCE(approved_by, $3),
           approved_at = COALESCE(approved_at, now()), updated_at = now()
         WHERE tenant_id = $1 AND run_id = $2
           AND artifact_type NOT IN ('VIDEO_LANDSCAPE', 'VIDEO_VERTICAL')`,
        [tenantId, runId, approvedBy],
      );
      await client.query(
        `UPDATE tasks SET status = 'AWAITING_VIDEO_APPROVAL', updated_at = now()
         WHERE tenant_id = $1 AND run_id = $2 AND task_type = 'MARKETING_PACK'`,
        [tenantId, runId],
      );
      let actionId = existing.rows[0]?.id;
      if (!actionId) {
        actionId = newId("action");
        await client.query(
          `INSERT INTO actions (
            id, tenant_id, run_id, agent_name, action_type, payload_hash,
            idempotency_key, mode, approval_status, approved_by, approved_at,
            provider_cost_microdollars, status, payload_json, executed_at
          ) VALUES (
            $1, $2, $3, 'admin', 'approve-marketing-pack', $4,
            $5, 'TEST', 'APPROVED', $6, now(), 0, 'EXECUTED', $7::jsonb, now()
          )`,
          [
            actionId,
            tenantId,
            runId,
            packHash,
            idempotencyKey,
            approvedBy,
            JSON.stringify({ persistedActionId: persisted.rows[0].id, packHash }),
          ],
        );
      }
      const videoAction = await client.query(
        `SELECT * FROM actions WHERE tenant_id = $1 AND run_id = $2
         AND action_type = 'video-render' ORDER BY created_at DESC LIMIT 1`,
        [tenantId, runId],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        runId,
        packHash,
        approvalStatus: "APPROVED",
        approvedBy,
        actionId,
        videoAction: parseAction(videoAction.rows[0]),
        replayed: existing.rowCount > 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistSiteArtifact({
    tenantId,
    runId,
    html,
    publicApiBaseUrl,
    review,
    revisionNumber,
    idempotencyKey,
    agentName,
  }) {
    const contentHash = sha256(html);
    const actionHash = payloadHash({
      contentHash,
      publicApiBaseUrl,
      review,
      revisionNumber,
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${tenantId}:site:${idempotencyKey}`,
      ]);
      const run = await client.query(
        "SELECT tenant_id, brand_document_id FROM runs WHERE id = $1 FOR UPDATE",
        [runId],
      );
      if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the site tenant");
      }
      const existing = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'persist-site-artifact'
           AND idempotency_key = $2`,
        [tenantId, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        if (existing.rows[0].payload_hash !== actionHash) {
          throw new ConflictError("The site idempotency key is bound to different HTML");
        }
        const artifact = await client.query(
          `SELECT id, revision_number, content_hash FROM site_artifacts
           WHERE run_id = $1 AND content_hash = $2`,
          [runId, contentHash],
        );
        const slug = await this.#businessSlug(client, tenantId);
        await client.query("COMMIT");
        return {
          actionId: existing.rows[0].id,
          artifactId: artifact.rows[0]?.id,
          revisionNumber: Number(artifact.rows[0]?.revision_number),
          contentHash,
          projectName: cloudflareProjectName(slug),
          files: { "index.html": html },
          replayed: true,
        };
      }
      const artifactId = newId("site");
      await client.query(
        `INSERT INTO site_artifacts (
          id, tenant_id, run_id, brand_document_id, revision_number,
          html_content, content_hash, validation_status, review_feedback
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PASSED', $8::jsonb)`,
        [
          artifactId,
          tenantId,
          runId,
          run.rows[0].brand_document_id,
          revisionNumber,
          html,
          contentHash,
          JSON.stringify(review.feedback ?? []),
        ],
      );
      await client.query(
        `UPDATE tasks SET status = 'READY_FOR_DEPLOY', output_ref = $3, updated_at = now()
         WHERE run_id = $1 AND tenant_id = $2 AND task_type = 'WEB_BUILD'`,
        [runId, tenantId, artifactId],
      );
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, provider_cost_microdollars,
          status, payload_json, executed_at
        ) VALUES (
          $1, $2, $3, $4, 'persist-site-artifact', $5, $6,
          'TEST', 'NOT_REQUIRED', 0, 'EXECUTED', $7::jsonb, now()
        )`,
        [
          actionId,
          tenantId,
          runId,
          agentName,
          actionHash,
          idempotencyKey,
          JSON.stringify({ artifactId, contentHash, revisionNumber, publicApiBaseUrl }),
        ],
      );
      const slug = await this.#businessSlug(client, tenantId);
      await client.query("COMMIT");
      return {
        actionId,
        artifactId,
        revisionNumber,
        contentHash,
        projectName: cloudflareProjectName(slug),
        files: { "index.html": html },
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Site artifact conflicts with an existing revision");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #businessSlug(client, tenantId) {
    const result = await client.query("SELECT business_slug FROM tenants WHERE id = $1", [
      tenantId,
    ]);
    if (result.rowCount === 0) throw new NotFoundError(`Tenant ${tenantId} was not found`);
    return result.rows[0].business_slug;
  }

  async createCheckoutReservation({
    siteOrigin,
    customer,
    startDate,
    endDate,
    items,
    idempotencyKey,
    actionPayloadHash,
    auditPayload,
  }) {
    const siteHost = new URL(siteOrigin).host.toLowerCase();
    const rentalDays = Math.round(
      (Date.parse(`${endDate}T00:00:00.000Z`) -
        Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `${siteHost}:checkout:${idempotencyKey}`,
      ]);
      const context = await client.query(
        `SELECT site_hosts.tenant_id,
          (SELECT id FROM runs
           WHERE runs.tenant_id = site_hosts.tenant_id
             AND runs.brand_document_id IS NOT NULL
           ORDER BY runs.created_at DESC LIMIT 1) AS run_id
         FROM site_hosts WHERE host = $1`,
        [siteHost],
      );
      if (context.rowCount === 0) {
        throw new NotFoundError("The requesting site is not mapped to an EPYHIA tenant");
      }
      const { tenant_id: tenantId, run_id: runId } = context.rows[0];
      if (!runId) throw new ConflictError("The tenant has no finalized business run");

      const existingAction = await client.query(
        `SELECT id, payload_hash FROM actions
         WHERE tenant_id = $1 AND action_type = 'checkout-session'
           AND idempotency_key = $2 FOR UPDATE`,
        [tenantId, idempotencyKey],
      );
      if (existingAction.rowCount > 0) {
        if (existingAction.rows[0].payload_hash !== actionPayloadHash) {
          throw new ConflictError(
            "The checkout idempotency key is bound to a different request",
          );
        }
        const existing = await client.query(
          `SELECT id, total_cents, currency, stripe_checkout_session_id,
            stripe_checkout_url
           FROM reservations
           WHERE tenant_id = $1 AND idempotency_key = $2`,
          [tenantId, idempotencyKey],
        );
        if (existing.rowCount === 0) {
          throw new ConflictError("The checkout audit exists without its reservation");
        }
        await client.query(
          `UPDATE actions SET status = CASE WHEN status = 'FAILED' THEN 'EXECUTING' ELSE status END,
            failure_message = CASE WHEN status = 'FAILED' THEN NULL ELSE failure_message END
           WHERE id = $1`,
          [existingAction.rows[0].id],
        );
        const lineItems = await this.#readReservationLineItems(
          client,
          existing.rows[0].id,
        );
        await client.query("COMMIT");
        return {
          tenantId,
          runId,
          actionId: existingAction.rows[0].id,
          reservationId: existing.rows[0].id,
          totalCents: Number(existing.rows[0].total_cents),
          currency: existing.rows[0].currency,
          checkoutSessionId: existing.rows[0].stripe_checkout_session_id,
          checkoutUrl: existing.rows[0].stripe_checkout_url,
          lineItems,
          replayed: true,
        };
      }

      const requestedIds = items.map((item) => item.itemId).sort();
      const rentalItems = await client.query(
        `SELECT id, name, description, available_quantity, day_rate_cents, currency
         FROM rental_items
         WHERE tenant_id = $1 AND active = true AND id = ANY($2::text[])
         ORDER BY id FOR UPDATE`,
        [tenantId, requestedIds],
      );
      if (rentalItems.rowCount !== requestedIds.length) {
        throw new ValidationError("One or more rental items are unavailable or unknown");
      }
      const reserved = await client.query(
        `SELECT reservation_items.rental_item_id,
          COALESCE(SUM(reservation_items.quantity), 0) AS reserved_quantity
         FROM reservation_items
         JOIN reservations ON reservations.id = reservation_items.reservation_id
         WHERE reservations.tenant_id = $1
           AND reservation_items.rental_item_id = ANY($2::text[])
           AND reservations.status IN ('PENDING', 'CONFIRMED')
           AND reservations.start_date < $4::date
           AND reservations.end_date > $3::date
         GROUP BY reservation_items.rental_item_id`,
        [tenantId, requestedIds, startDate, endDate],
      );
      const reservedByItem = new Map(
        reserved.rows.map((row) => [row.rental_item_id, Number(row.reserved_quantity)]),
      );
      const requestedByItem = new Map(items.map((item) => [item.itemId, item.quantity]));
      const currencies = new Set(rentalItems.rows.map((item) => item.currency));
      if (currencies.size !== 1) {
        throw new ConflictError("A reservation cannot mix catalog currencies");
      }

      let totalCents = 0;
      const lineItems = rentalItems.rows.map((item) => {
        const quantity = requestedByItem.get(item.id);
        const remaining = Number(item.available_quantity) - (reservedByItem.get(item.id) ?? 0);
        if (quantity > remaining) {
          throw new ConflictError(`${item.name} does not have enough availability`, {
            itemId: item.id,
            availableQuantity: Math.max(remaining, 0),
          });
        }
        const dayRateCents = Number(item.day_rate_cents);
        const unitAmountCents = dayRateCents * rentalDays;
        totalCents += unitAmountCents * quantity;
        return {
          itemId: item.id,
          name: item.name,
          description: item.description,
          quantity,
          dayRateCents,
          rentalDays,
          unitAmountCents,
        };
      });
      if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
        throw new ConflictError("The authoritative reservation total is invalid");
      }

      const normalizedEmail = customer.email.trim().toLowerCase();
      const customerResult = await client.query(
        `INSERT INTO customers (id, tenant_id, name, email, normalized_email)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, normalized_email) DO UPDATE SET
           name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()
         RETURNING id`,
        [newId("customer"), tenantId, customer.name.trim(), customer.email.trim(), normalizedEmail],
      );
      const reservationId = newId("reservation");
      await client.query(
        `INSERT INTO reservations (
          id, tenant_id, run_id, customer_id, idempotency_key,
          start_date, end_date, rental_days, status, total_cents, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10)`,
        [
          reservationId,
          tenantId,
          runId,
          customerResult.rows[0].id,
          idempotencyKey,
          startDate,
          endDate,
          rentalDays,
          totalCents,
          [...currencies][0],
        ],
      );
      for (const item of lineItems) {
        await client.query(
          `INSERT INTO reservation_items (
            id, reservation_id, rental_item_id, quantity,
            day_rate_cents, rental_days, line_total_cents
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            newId("reservation_item"),
            reservationId,
            item.itemId,
            item.quantity,
            item.dayRateCents,
            rentalDays,
            item.unitAmountCents * item.quantity,
          ],
        );
      }
      const actionId = newId("action");
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, status, payload_json
        ) VALUES (
          $1, $2, $3, 'ops', 'checkout-session', $4, $5,
          'TEST', 'NOT_REQUIRED', 'EXECUTING', $6::jsonb
        )`,
        [
          actionId,
          tenantId,
          runId,
          actionPayloadHash,
          idempotencyKey,
          JSON.stringify(auditPayload),
        ],
      );
      await client.query("COMMIT");
      return {
        tenantId,
        runId,
        actionId,
        reservationId,
        totalCents,
        currency: [...currencies][0],
        checkoutSessionId: null,
        checkoutUrl: null,
        lineItems,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error.code === "23505") {
        throw new ConflictError("Checkout conflicts with an existing identity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #readReservationLineItems(client, reservationId) {
    const result = await client.query(
      `SELECT rental_items.id, rental_items.name, rental_items.description,
        reservation_items.quantity, reservation_items.day_rate_cents,
        reservation_items.rental_days
       FROM reservation_items
       JOIN rental_items ON rental_items.id = reservation_items.rental_item_id
       WHERE reservation_items.reservation_id = $1
       ORDER BY rental_items.id`,
      [reservationId],
    );
    return result.rows.map((item) => ({
      itemId: item.id,
      name: item.name,
      description: item.description,
      quantity: Number(item.quantity),
      dayRateCents: Number(item.day_rate_cents),
      rentalDays: Number(item.rental_days),
      unitAmountCents: Number(item.day_rate_cents) * Number(item.rental_days),
    }));
  }

  async completeCheckoutSession({
    reservationId,
    actionId,
    checkoutSessionId,
    checkoutUrl,
    expiresAt,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT stripe_checkout_session_id FROM reservations WHERE id = $1 FOR UPDATE`,
        [reservationId],
      );
      if (result.rowCount === 0) {
        throw new NotFoundError(`Reservation ${reservationId} was not found`);
      }
      const existingSessionId = result.rows[0].stripe_checkout_session_id;
      if (existingSessionId && existingSessionId !== checkoutSessionId) {
        throw new ConflictError("Reservation is already bound to another Stripe session");
      }
      await client.query(
        `UPDATE reservations SET stripe_checkout_session_id = $2,
          stripe_checkout_url = $3, stripe_expires_at = $4, updated_at = now()
         WHERE id = $1`,
        [reservationId, checkoutSessionId, checkoutUrl, expiresAt],
      );
      await client.query(
        `UPDATE actions SET status = 'EXECUTED', provider_reference = $2,
          executed_at = now(), failure_message = NULL WHERE id = $1`,
        [actionId, checkoutSessionId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async processStripeWebhook({ event }) {
    const session = event.data?.object;
    const reservationId = session?.metadata?.reservation_id;
    const tenantId = session?.metadata?.tenant_id;
    if (!event.id || !reservationId || !tenantId || !session?.id) {
      throw new ValidationError("Stripe event is missing EPYHIA reservation metadata");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const insertedEvent = await client.query(
        `INSERT INTO webhook_events (stripe_event_id, event_type, livemode, tenant_id)
         VALUES ($1, $2, false, $3)
         ON CONFLICT (stripe_event_id) DO NOTHING
         RETURNING stripe_event_id`,
        [event.id, event.type, tenantId],
      );
      if (insertedEvent.rowCount === 0) {
        await client.query("COMMIT");
        return { eventId: event.id, replayed: true, ignored: false };
      }
      const reservationResult = await client.query(
        `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
        [reservationId],
      );
      if (reservationResult.rowCount === 0) {
        throw new NotFoundError(`Reservation ${reservationId} was not found`);
      }
      const reservation = reservationResult.rows[0];
      if (reservation.tenant_id !== tenantId) {
        throw new ConflictError("Stripe tenant metadata does not match reservation");
      }
      if (
        reservation.stripe_checkout_session_id &&
        reservation.stripe_checkout_session_id !== session.id
      ) {
        throw new ConflictError("Stripe session does not match reservation");
      }

      let orderId = null;
      let reservationStatus = reservation.status;
      if (event.type === "checkout.session.completed") {
        if (session.payment_status !== "paid") {
          throw new ConflictError("Stripe session is not paid");
        }
        if (
          Number(session.amount_total) !== Number(reservation.total_cents) ||
          session.currency?.toLowerCase() !== reservation.currency
        ) {
          throw new ConflictError("Stripe payment amount or currency does not match reservation");
        }
        if (reservation.status === "CANCELLED") {
          throw new ConflictError("A cancelled reservation cannot become a paid order");
        }
        const existingOrder = await client.query(
          "SELECT * FROM orders WHERE reservation_id = $1",
          [reservationId],
        );
        if (existingOrder.rowCount > 0) {
          const order = existingOrder.rows[0];
          if (
            order.stripe_checkout_session_id !== session.id ||
            Number(order.amount_cents) !== Number(session.amount_total) ||
            order.currency !== session.currency.toLowerCase()
          ) {
            throw new ConflictError("Persisted order does not match the Stripe event");
          }
          orderId = order.id;
        } else {
          orderId = newId("order");
          await client.query(
            `INSERT INTO orders (
              id, tenant_id, reservation_id, stripe_checkout_session_id,
              amount_cents, currency, status, payment_timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, 'PAID', $7)`,
            [
              orderId,
              tenantId,
              reservationId,
              session.id,
              session.amount_total,
              session.currency.toLowerCase(),
              new Date(event.created * 1000),
            ],
          );
        }
        await client.query(
          `UPDATE reservations SET status = 'CONFIRMED',
            stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1`,
          [reservationId, session.id],
        );
        reservationStatus = "CONFIRMED";
      } else if (event.type === "checkout.session.expired") {
        if (reservation.status === "PENDING") {
          await client.query(
            `UPDATE reservations SET status = 'CANCELLED',
              stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1`,
            [reservationId, session.id],
          );
          reservationStatus = "CANCELLED";
        }
      }

      const webhookPayload = {
        eventId: event.id,
        eventType: event.type,
        reservationId,
        tenantId,
        checkoutSessionId: session.id,
        amountTotal: session.amount_total ?? null,
        currency: session.currency ?? null,
        paymentStatus: session.payment_status ?? null,
      };
      await client.query(
        `INSERT INTO actions (
          id, tenant_id, run_id, agent_name, action_type, payload_hash,
          idempotency_key, mode, approval_status, provider_reference,
          provider_cost_microdollars, status, payload_json, executed_at
        ) VALUES (
          $1, $2, $3, 'ops', 'process-stripe-webhook', $4, $5,
          'TEST', 'NOT_REQUIRED', $6, 0, 'EXECUTED', $7::jsonb, now()
        )`,
        [
          newId("action"),
          tenantId,
          reservation.run_id,
          payloadHash(webhookPayload),
          event.id,
          session.id,
          JSON.stringify(webhookPayload),
        ],
      );
      await client.query("COMMIT");
      return {
        eventId: event.id,
        reservationId,
        orderId,
        status: reservationStatus,
        replayed: false,
        ignored: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readOrderStatus(reservationId, siteHost) {
    const result = await this.pool.query(
      `SELECT reservations.id AS reservation_id,
        reservations.status AS reservation_status,
        reservations.total_cents,
        reservations.currency,
        orders.id AS order_id,
        orders.status AS order_status,
        orders.payment_timestamp
       FROM reservations
       JOIN site_hosts ON site_hosts.tenant_id = reservations.tenant_id
       LEFT JOIN orders ON orders.reservation_id = reservations.id
       WHERE reservations.id = $1 AND site_hosts.host = $2`,
      [reservationId, siteHost],
    );
    if (result.rowCount === 0) {
      throw new NotFoundError(`Reservation ${reservationId} was not found`);
    }
    const row = result.rows[0];
    return {
      reservationId: row.reservation_id,
      reservationStatus: row.reservation_status,
      totalCents: Number(row.total_cents),
      currency: row.currency,
      order: row.order_id
        ? {
            id: row.order_id,
            status: row.order_status,
            paymentTimestamp:
              row.payment_timestamp?.toISOString?.() ?? row.payment_timestamp,
          }
        : null,
    };
  }

  async #readRun(client, runId) {
    const runResult = await client.query(
      `SELECT tenant_id, brand_document_id, status FROM runs WHERE id = $1`,
      [runId],
    );
    if (runResult.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
    const taskResult = await client.query(
      `SELECT id, task_type, status FROM tasks WHERE run_id = $1 ORDER BY task_type`,
      [runId],
    );
    const brandResult = runResult.rows[0].brand_document_id
      ? await client.query(
          `SELECT version_number, full_text, content_hash, approval_status
           FROM brand_documents WHERE id = $1`,
          [runResult.rows[0].brand_document_id],
        )
      : { rows: [] };
    const actionResult = await client.query(
      `SELECT id FROM actions
       WHERE run_id = $1 AND action_type = 'create-run-shell'`,
      [runId],
    );
    return {
      tenantId: runResult.rows[0].tenant_id,
      runId,
      status: runResult.rows[0].status,
      brandDocumentId: runResult.rows[0].brand_document_id,
      brandVersion: brandResult.rows[0]
        ? Number(brandResult.rows[0].version_number)
        : null,
      brandDocumentHash: brandResult.rows[0]
        ? brandResult.rows[0].content_hash ?? sha256(brandResult.rows[0].full_text)
        : null,
      brandApprovalStatus: brandResult.rows[0]?.approval_status ?? null,
      tasks: taskResult.rows.map((row) => ({
        id: row.id,
        taskType: row.task_type,
        status: row.status,
      })),
      actionId: actionResult.rows[0]?.id,
    };
  }

  async reserveAgentCall({
    tenantId,
    runId,
    taskId,
    agentName,
    modelId,
    modelTier,
    reservedCostMicrodollars,
    idempotencyKey,
    requestHash,
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query(
        `SELECT tenant_id, approved_budget_microdollars
         FROM runs WHERE id = $1 FOR UPDATE`,
        [runId],
      );
      if (run.rowCount === 0) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.rows[0].tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the model-call tenant");
      }
      if (taskId) {
        const task = await client.query(
          `SELECT 1 FROM tasks
           WHERE id = $1 AND run_id = $2 AND tenant_id = $3`,
          [taskId, runId, tenantId],
        );
        if (task.rowCount !== 1) {
          throw new ConflictError("Task does not belong to the model-call run");
        }
      }
      const existing = await client.query(
        `SELECT id, request_hash, model_id, input_tokens, cached_input_tokens,
          output_tokens, cost_microdollars, output_text, status,
          started_at <= now() - interval '15 minutes' AS stale
         FROM agent_calls
         WHERE run_id = $1 AND agent_name = $2 AND idempotency_key = $3
         FOR UPDATE`,
        [runId, agentName, idempotencyKey],
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.request_hash !== requestHash) {
          throw new ConflictError(
            "The model-call idempotency key is bound to a different request",
          );
        }
        if (row.status === "COMPLETED") {
          await client.query("COMMIT");
          return {
            replayed: true,
            result: {
              callId: row.id,
              model: row.model_id,
              outputText: row.output_text,
              usage: {
                inputTokens: Number(row.input_tokens),
                cachedInputTokens: Number(row.cached_input_tokens),
                outputTokens: Number(row.output_tokens),
                costMicrodollars: Number(row.cost_microdollars),
              },
              replayed: true,
            },
          };
        }
        if (row.status === "IN_PROGRESS") {
          if (!row.stale) {
            throw new ConflictError("The model call is already in progress");
          }
          await client.query(
            "UPDATE agent_calls SET started_at = now() WHERE id = $1",
            [row.id],
          );
          await client.query("COMMIT");
          return {
            callId: row.id,
            replayed: false,
            resumed: true,
          };
        }
      }
      const used = await client.query(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'IN_PROGRESS'
            THEN reserved_cost_microdollars ELSE cost_microdollars END), 0) AS model_cost,
          COALESCE((SELECT SUM(provider_cost_microdollars) FROM actions WHERE run_id = $1), 0)
            AS action_cost
         FROM agent_calls WHERE run_id = $1`,
        [runId],
      );
      const committed =
        Number(used.rows[0].model_cost) + Number(used.rows[0].action_cost);
      const budget = Number(run.rows[0].approved_budget_microdollars);
      if (committed + reservedCostMicrodollars > budget) {
        throw new ConflictError("The model call would exceed the approved run budget", {
          budgetMicrodollars: budget,
          committedMicrodollars: committed,
          requestedMicrodollars: reservedCostMicrodollars,
        });
      }
      const callId = existing.rows[0]?.id ?? newId("call");
      if (existing.rowCount > 0) {
        await client.query(
          `UPDATE agent_calls SET task_id = $2, model_id = $3, model_tier = $4,
            reserved_cost_microdollars = $5, cost_microdollars = 0,
            input_tokens = 0, cached_input_tokens = 0, output_tokens = 0,
            provider_reference = NULL, output_text = NULL, error_message = NULL,
            status = 'IN_PROGRESS', started_at = now(), completed_at = NULL
           WHERE id = $1`,
          [callId, taskId ?? null, modelId, modelTier, reservedCostMicrodollars],
        );
      } else {
        await client.query(
          `INSERT INTO agent_calls (
            id, run_id, task_id, agent_name, model_id, model_tier,
            reserved_cost_microdollars, idempotency_key, request_hash, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'IN_PROGRESS')`,
          [
            callId,
            runId,
            taskId ?? null,
            agentName,
            modelId,
            modelTier,
            reservedCostMicrodollars,
            idempotencyKey,
            requestHash,
          ],
        );
      }
      await client.query("COMMIT");
      return {
        callId,
        remainingBudgetMicrodollars: budget - committed - reservedCostMicrodollars,
        replayed: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeAgentCall({
    callId,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costMicrodollars,
    providerReference,
    outputText,
  }) {
    await this.pool.query(
      `UPDATE agent_calls SET
        input_tokens = $2, cached_input_tokens = $3, output_tokens = $4,
        cost_microdollars = $5, reserved_cost_microdollars = 0,
        provider_reference = $6, output_text = $7,
        status = 'COMPLETED', completed_at = now()
       WHERE id = $1`,
      [
        callId,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costMicrodollars,
        providerReference,
        outputText,
      ],
    );
  }

  async failAgentCall(callId, message) {
    await this.pool.query(
      `UPDATE agent_calls SET reserved_cost_microdollars = 0,
        status = 'FAILED', error_message = $2, completed_at = now()
       WHERE id = $1`,
      [callId, String(message).slice(0, 1000)],
    );
  }
}
