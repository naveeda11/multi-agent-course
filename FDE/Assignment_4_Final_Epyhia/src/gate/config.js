import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CapabilityRegistry, ACTIONS } from "./capabilities.js";
import { GateRepository } from "./repository.js";
import { LocalDeploymentProvider } from "./providers/local-deployment.js";
import { CloudflareDeploymentProvider } from "./providers/cloudflare-deployment.js";
import { NeonRepository } from "./neon-repository.js";
import { OnboardingService } from "./onboarding-service.js";
import { ModelService } from "./model-service.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import { StripeSandboxProvider } from "./providers/stripe-sandbox.js";
import { CheckoutService } from "./checkout-service.js";
import { CatalogService } from "./catalog-service.js";
import { MarketingService } from "./marketing-service.js";
import { SiteService } from "./site-service.js";
import { VideoService } from "./video-service.js";
import { VertexVeoProvider } from "./providers/vertex-veo.js";
import { R2ArtifactStorage } from "./providers/r2-artifact-storage.js";
import { ErasureService } from "./erasure-service.js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function googleCredentialsFromEnvironment() {
  const value = process.env.GOOGLE_CLOUD_CREDENTIALS_JSON;
  if (!value) return null;
  let credentials;
  try {
    credentials = JSON.parse(value);
  } catch {
    throw new Error("GOOGLE_CLOUD_CREDENTIALS_JSON must contain valid JSON");
  }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("GOOGLE_CLOUD_CREDENTIALS_JSON must contain a credential object");
  }
  return credentials;
}

export function loadGateDependencies() {
  if (process.env.NODE_ENV === "production") {
    for (const name of [
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "STRIPE_SANDBOX_PUBLISHABLE_KEY",
      "STRIPE_SANDBOX_SECRET_KEY",
    ]) {
      required(name);
    }
  }
  const neonRepository = process.env.DATABASE_URL
    ? new NeonRepository({ connectionString: process.env.DATABASE_URL })
    : null;
  let repository = neonRepository;
  if (!repository) {
    const dbPath = resolve(process.env.ACTION_GATE_DB_PATH ?? ".data/action-gate.sqlite");
    mkdirSync(dirname(dbPath), { recursive: true });
    repository = new GateRepository(dbPath);
  }
  const capabilities = new CapabilityRegistry([
    {
      handle: required("WEB_BUILDER_CAPABILITY_HANDLE"),
      subject: "web-builder",
      actions: [
        ACTIONS.DEPLOY,
        ACTIONS.MODEL_CALL,
        ACTIONS.READ_RUN_CONTEXT,
        ACTIONS.PERSIST_SITE_ARTIFACT,
      ],
    },
    {
      handle: required("ADMIN_APPROVAL_CAPABILITY_HANDLE"),
      subject: "admin",
      actions: [
        ACTIONS.APPROVE,
        ACTIONS.READ_AUDIT,
        ACTIONS.READ_RUN_AUDIT,
        ACTIONS.READ_TENANT_PROFILE,
        ACTIONS.READ_RUN_CONTEXT,
        ACTIONS.ERASE_TENANT,
      ],
    },
    {
      handle: required("RUNTIME_CONTROL_CAPABILITY_HANDLE"),
      subject: "orchestration-runtime",
      actions: [ACTIONS.CREATE_RUN_SHELL],
    },
    {
      handle: required("STRATEGIST_CAPABILITY_HANDLE"),
      subject: "strategist",
      actions: [ACTIONS.MODEL_CALL],
    },
    {
      handle: required("OPS_CAPABILITY_HANDLE"),
      subject: "ops",
      actions: [
        ACTIONS.MODEL_CALL,
        ACTIONS.FINALIZE_RUN,
        ACTIONS.CREATE_CHECKOUT_SESSION,
        ACTIONS.PROCESS_STRIPE_WEBHOOK,
        ACTIONS.PERSIST_CATALOG,
        ACTIONS.READ_ORDER_STATUS,
      ],
    },
    {
      handle: required("MARKETER_CAPABILITY_HANDLE"),
      subject: "marketer",
      actions: [
        ACTIONS.MODEL_CALL,
        ACTIONS.READ_RUN_CONTEXT,
        ACTIONS.PERSIST_MARKETING_PACK,
        ACTIONS.VIDEO_RENDER,
      ],
    },
  ]);
  const providerName = process.env.DEPLOY_PROVIDER ?? "local";
  const deploymentProvider =
    providerName === "cloudflare"
      ? new CloudflareDeploymentProvider({
          accountId: required("CLOUDFLARE_ACCOUNT_ID"),
          apiToken: required("CLOUDFLARE_API_TOKEN"),
        })
      : new LocalDeploymentProvider({
          root: process.env.LOCAL_DEPLOY_ROOT ?? ".deployments",
        });
  const onboardingService = neonRepository
    ? new OnboardingService({ repository: neonRepository })
    : null;
  const modelService = neonRepository && process.env.OPENAI_API_KEY
    ? new ModelService({
        repository: neonRepository,
        provider: new OpenAIResponsesProvider({ apiKey: process.env.OPENAI_API_KEY }),
      })
    : null;
  const stripeProvider = neonRepository && process.env.STRIPE_SANDBOX_SECRET_KEY
    ? new StripeSandboxProvider({
        secretKey: process.env.STRIPE_SANDBOX_SECRET_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      })
    : null;
  const checkoutService = stripeProvider
    ? new CheckoutService({
        repository: neonRepository,
        provider: stripeProvider,
      })
    : null;
  const catalogService = neonRepository
    ? new CatalogService({ repository: neonRepository })
    : null;
  const marketingService = neonRepository
    ? new MarketingService({ repository: neonRepository })
    : null;
  const siteService = neonRepository
    ? new SiteService({ repository: neonRepository })
    : null;
  const r2Storage = neonRepository
    ? new R2ArtifactStorage({
        endpoint: required("CLOUDFLARE_R2_S3_URL"),
        accessKeyId: required("CLOUDFLARE_R2_ACCESS_KEY_ID"),
        secretAccessKey: required("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
        bucket: required("R2_BUCKET"),
      })
    : null;
  const googleCredentials = googleCredentialsFromEnvironment();
  const googleCredentialsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCredentials && googleCredentialsFile) {
    throw new Error(
      "Configure only one of GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_CREDENTIALS_JSON",
    );
  }
  const hasGoogleCredentials = Boolean(googleCredentials || googleCredentialsFile);
  if (Boolean(process.env.GOOGLE_CLOUD_PROJECT) !== hasGoogleCredentials) {
    throw new Error(
      "Veo requires GOOGLE_CLOUD_PROJECT and either GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CLOUD_CREDENTIALS_JSON",
    );
  }
  const videoService = neonRepository && process.env.GOOGLE_CLOUD_PROJECT && hasGoogleCredentials
    ? new VideoService({
        repository: neonRepository,
        storage: r2Storage,
        provider: new VertexVeoProvider({
          projectId: process.env.GOOGLE_CLOUD_PROJECT,
          credentialsFile: googleCredentialsFile,
          credentials: googleCredentials,
          location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
        }),
      })
    : null;
  const erasureService = neonRepository
    ? new ErasureService({
        repository: neonRepository,
        deploymentProvider,
        storage: r2Storage,
        stripeProvider,
      })
    : null;
  return {
    repository,
    capabilities,
    deploymentProvider,
    onboardingService,
    modelService,
    checkoutService,
    catalogService,
    marketingService,
    siteService,
    videoService,
    erasureService,
    neonRepository,
  };
}
