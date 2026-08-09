import { ActionGateClient } from "./gate-client.js";
import { OnboardingRuntime } from "./onboarding-runtime.js";
import { Ops } from "./ops.js";
import { Strategist } from "./strategist.js";
import { Marketer } from "./marketer.js";
import { WebBuilder } from "./web-builder.js";
import { ApprovalCoordinator } from "./approval-coordinator.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function loadRuntimeDependencies() {
  const baseUrl = required("ACTION_GATE_URL");
  const controlGateClient = new ActionGateClient({
    baseUrl,
    capabilityHandle: required("RUNTIME_CONTROL_CAPABILITY_HANDLE"),
    agentName: "orchestration-runtime",
  });
  const strategist = new Strategist({
    modelGateway: new ActionGateClient({
      baseUrl,
      capabilityHandle: required("STRATEGIST_CAPABILITY_HANDLE"),
      agentName: "strategist",
    }),
  });
  const ops = new Ops({
    gateClient: new ActionGateClient({
      baseUrl,
      capabilityHandle: required("OPS_CAPABILITY_HANDLE"),
      agentName: "ops",
    }),
  });
  const marketerGateClient = new ActionGateClient({
    baseUrl,
    capabilityHandle: required("MARKETER_CAPABILITY_HANDLE"),
    agentName: "marketer",
  });
  const marketer = new Marketer({
    gateClient: marketerGateClient,
  });
  const webBuilderGateClient = new ActionGateClient({
    baseUrl,
    capabilityHandle: required("WEB_BUILDER_CAPABILITY_HANDLE"),
    agentName: "web-builder",
  });
  const webBuilder = new WebBuilder({
    gateClient: webBuilderGateClient,
    publicApiBaseUrl: required("PUBLIC_API_BASE_URL"),
  });
  const adminGateClient = new ActionGateClient({
    baseUrl,
    capabilityHandle: required("ADMIN_APPROVAL_CAPABILITY_HANDLE"),
    agentName: "admin",
  });
  const approvalCoordinator = new ApprovalCoordinator({
    adminGateClient,
    webBuilderGateClient,
    marketerGateClient,
  });
  return {
    onboardingRuntime: new OnboardingRuntime({
      controlGateClient,
      strategist,
      ops,
    }),
    ops,
    marketer,
    webBuilder,
    approvalCoordinator,
    runStatusReader: adminGateClient,
    runAuditReader: adminGateClient,
    tenantProfileReader: adminGateClient,
  };
}
