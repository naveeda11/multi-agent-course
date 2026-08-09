import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { newId } from "../shared/canonical.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));
const STALE_EXECUTION_MS = 15 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

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
    approvedAt: row.approved_at,
    providerReference: row.provider_reference,
    providerCostMicrodollars: row.provider_cost_microdollars,
    status: row.status,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    executionStartedAt: row.execution_started_at,
    executedAt: row.executed_at,
  };
}

export class GateRepository {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(schemaPath, "utf8"));
  }

  close() {
    this.db.close();
  }

  createTenant({ id = newId("tenant"), name, businessSlug }) {
    this.db
      .prepare(
        "INSERT INTO tenants (id, name, business_slug, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, name, businessSlug, now());
    return { id, name, businessSlug };
  }

  createRun({
    id = newId("run"),
    tenantId,
    originalBrief,
    briefHash,
    approvedBudgetMicrodollars = 0,
    status = "RUNNING",
  }) {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, tenant_id, original_brief, brief_hash,
          approved_budget_microdollars, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        originalBrief,
        briefHash,
        approvedBudgetMicrodollars,
        status,
        now(),
      );
    return { id, tenantId };
  }

  findActionById(actionId) {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId);
    return parseAction(row);
  }

  requireAction(actionId) {
    const action = this.findActionById(actionId);
    if (!action) throw new NotFoundError(`Action ${actionId} was not found`);
    return action;
  }

  findActionByIdempotency({ tenantId, actionType, idempotencyKey }) {
    const row = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE tenant_id = ? AND action_type = ? AND idempotency_key = ?`,
      )
      .get(tenantId, actionType, idempotencyKey);
    return parseAction(row);
  }

  createPendingAction({
    tenantId,
    runId,
    agentName,
    actionType,
    payloadHash,
    idempotencyKey,
    mode,
    payload,
    approvalRequired,
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db
        .prepare("SELECT tenant_id FROM runs WHERE id = ?")
        .get(runId);
      if (!run) throw new NotFoundError(`Run ${runId} was not found`);
      if (run.tenant_id !== tenantId) {
        throw new ConflictError("Run does not belong to the action tenant");
      }
      const existing = this.findActionByIdempotency({
        tenantId,
        actionType,
        idempotencyKey,
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictError(
            "The idempotency key is already bound to a different payload",
            { actionId: existing.id },
          );
        }
        this.db.exec("COMMIT");
        return { action: existing, replayed: true };
      }

      if (actionType === "deploy") {
        const binding = this.db
          .prepare("SELECT project_name FROM deployment_projects WHERE tenant_id = ?")
          .get(tenantId);
        if (binding && binding.project_name !== payload.projectName) {
          throw new ConflictError(
            "A tenant deployment is permanently bound to its existing project",
            { projectName: binding.project_name },
          );
        }
        if (!binding) {
          this.db
            .prepare(
              `INSERT INTO deployment_projects (tenant_id, project_name, created_at)
               VALUES (?, ?, ?)`,
            )
            .run(tenantId, payload.projectName, now());
        }
      }

      const id = newId("action");
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO actions (
            id, tenant_id, run_id, agent_name, action_type, payload_hash,
            idempotency_key, mode, approval_status, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          tenantId,
          runId,
          agentName,
          actionType,
          payloadHash,
          idempotencyKey,
          mode,
          approvalRequired ? "PENDING" : "NOT_REQUIRED",
          approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
          timestamp,
        );
      this.db
        .prepare("INSERT INTO action_payloads (action_id, payload_json) VALUES (?, ?)")
        .run(id, JSON.stringify(payload));
      this.db.exec("COMMIT");
      return { action: this.requireAction(id), replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  approveAction({ actionId, payloadHash, approvedBy, tenantId }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.requireAction(actionId);
      if (action.tenantId !== tenantId) {
        throw new ConflictError("Approval action does not belong to this tenant");
      }
      if (action.payloadHash !== payloadHash) {
        throw new ConflictError("Approval does not match the action payload hash", {
          actionId,
        });
      }
      if (action.status === "EXECUTED") {
        this.db.exec("COMMIT");
        return action;
      }
      if (action.approvalStatus === "APPROVED") {
        this.db.exec("COMMIT");
        return action;
      }
      const timestamp = now();
      this.db
        .prepare(
          `UPDATE actions
           SET approval_status = 'APPROVED', approved_by = ?, approved_at = ?, status = 'APPROVED'
           WHERE id = ?`,
        )
        .run(approvedBy, timestamp, actionId);
      this.db.exec("COMMIT");
      return this.requireAction(actionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimForExecution(actionId) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.requireAction(actionId);
      if (action.status === "EXECUTED") {
        this.db.exec("COMMIT");
        return { action, claimed: false };
      }
      if (action.approvalStatus === "PENDING") {
        this.db.exec("COMMIT");
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
          this.db
            .prepare(
              `UPDATE actions SET status = 'FAILED', approval_status = 'PENDING',
                approved_by = NULL, approved_at = NULL, execution_started_at = NULL,
                failure_message = ? WHERE id = ?`,
            )
            .run(
              "A stale paid-video execution requires fresh administrator approval",
              actionId,
            );
          this.db.exec("COMMIT");
          return { action: this.requireAction(actionId), claimed: false, recovered: true };
        }
        const timestamp = now();
        this.db
          .prepare(
            `UPDATE actions SET execution_started_at = ?, failure_message = NULL
             WHERE id = ?`,
          )
          .run(timestamp, actionId);
        this.db.exec("COMMIT");
        return { action: this.requireAction(actionId), claimed: true, recovered: true };
      }
      const timestamp = now();
      this.db
        .prepare(
          `UPDATE actions SET status = 'EXECUTING', execution_started_at = ?,
            failure_message = NULL WHERE id = ?`,
        )
        .run(timestamp, actionId);
      this.db.exec("COMMIT");
      return { action: this.requireAction(actionId), claimed: true, recovered: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPayload(actionId) {
    const row = this.db
      .prepare("SELECT payload_json FROM action_payloads WHERE action_id = ?")
      .get(actionId);
    if (!row) throw new NotFoundError(`Payload for action ${actionId} was not found`);
    return JSON.parse(row.payload_json);
  }

  completeDeployment({
    actionId,
    tenantId,
    projectName,
    providerReference,
    providerCostMicrodollars,
    liveUrl,
    verifiedAt,
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const action = this.requireAction(actionId);
      if (
        action.tenantId !== tenantId ||
        action.actionType !== "deploy" ||
        action.approvalStatus !== "APPROVED" ||
        action.status !== "EXECUTING"
      ) {
        throw new ConflictError("Deployment completion does not match its approved action");
      }
      const timestamp = now();
      this.db
        .prepare(
          `UPDATE actions
           SET status = 'EXECUTED', provider_reference = ?,
               provider_cost_microdollars = ?, execution_started_at = NULL,
               executed_at = ?, failure_message = NULL
           WHERE id = ?`,
        )
        .run(providerReference, providerCostMicrodollars, timestamp, actionId);
      this.db
        .prepare(
          `INSERT INTO deployments (
            id, tenant_id, cloudflare_project_name, live_url,
            last_action_id, verified_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id) DO UPDATE SET
            live_url = excluded.live_url,
            last_action_id = excluded.last_action_id,
            verified_at = excluded.verified_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          newId("deployment"),
          tenantId,
          projectName,
          liveUrl,
          actionId,
          verifiedAt,
          timestamp,
        );
      this.db.exec("COMMIT");
      return this.requireAction(actionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  failAction(actionId, message) {
    this.db
      .prepare(
        `UPDATE actions SET status = 'FAILED', execution_started_at = NULL,
          failure_message = ? WHERE id = ?`,
      )
      .run(String(message).slice(0, 1000), actionId);
    return this.requireAction(actionId);
  }

  getDeployment(tenantId) {
    return this.db
      .prepare("SELECT * FROM deployments WHERE tenant_id = ?")
      .get(tenantId);
  }
}
