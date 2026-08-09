import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ActionGate } from "../src/gate/action-gate.js";
import { ACTIONS, CapabilityRegistry } from "../src/gate/capabilities.js";
import { LocalDeploymentProvider } from "../src/gate/providers/local-deployment.js";
import { GateRepository } from "../src/gate/repository.js";
import { sha256 } from "../src/shared/canonical.js";

const root = await mkdtemp(resolve(tmpdir(), "epyhia-demo-"));
const repository = new GateRepository();

try {
  repository.createTenant({
    id: "tenant_party_rentals",
    name: "EPYHIA Demo",
    businessSlug: "brightday-party-rentals",
  });
  repository.createRun({
    id: "run_party_rentals",
    tenantId: "tenant_party_rentals",
    originalBrief: "A trustworthy local party-rental business",
    briefHash: sha256("A trustworthy local party-rental business"),
    approvedBudgetMicrodollars: 1_000_000,
  });

  const capabilities = new CapabilityRegistry([
    { handle: "web-handle", subject: "web-builder", actions: [ACTIONS.DEPLOY] },
    { handle: "admin-handle", subject: "admin", actions: [ACTIONS.APPROVE] },
  ]);
  const gate = new ActionGate({
    repository,
    capabilities,
    deploymentProvider: new LocalDeploymentProvider({ root }),
  });

  const requested = gate.requestDeploy({
    capabilityHandle: "web-handle",
    tenantId: "tenant_party_rentals",
    runId: "run_party_rentals",
    agentName: "web-builder",
    idempotencyKey: "brightday-site-v1",
    mode: "TEST",
    payload: {
      projectName: "brightday-party-rentals",
      files: {
        "index.html": "<!doctype html><title>BrightDay Party Rentals</title><h1>Make room for a bright day.</h1>",
      },
    },
  });
  process.stdout.write(`1. Requested: ${requested.action.status}\n`);

  const approved = gate.approve({
    capabilityHandle: "admin-handle",
    actionId: requested.action.id,
    payloadHash: requested.action.payloadHash,
    approvedBy: "admin",
  });
  process.stdout.write(`2. Approved: ${approved.status}\n`);

  const executed = await gate.executeDeploy({
    capabilityHandle: "web-handle",
    actionId: requested.action.id,
    agentName: "web-builder",
  });
  process.stdout.write(`3. Executed and verified: ${executed.action.status}\n`);

  const replay = await gate.executeDeploy({
    capabilityHandle: "web-handle",
    actionId: requested.action.id,
    agentName: "web-builder",
  });
  process.stdout.write(`4. Safe retry returned existing action: ${replay.replayed}\n`);
  process.stdout.write(`${JSON.stringify(repository.requireAction(requested.action.id), null, 2)}\n`);
} finally {
  repository.close();
  await rm(root, { recursive: true, force: true });
}
