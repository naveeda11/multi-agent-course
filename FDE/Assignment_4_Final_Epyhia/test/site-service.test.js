import assert from "node:assert/strict";
import { test } from "node:test";
import { SiteService } from "../src/gate/site-service.js";
import { WebBuilder } from "../src/runtime/web-builder.js";
import { ValidationError } from "../src/shared/errors.js";

const context = {
  business: {
    name: "BrightDay Rentals",
    email: "hello@brightday.example",
    phone: "555-0100",
    address: "10 Market Street",
  },
  catalog: [
    {
      id: "item_chair",
      name: "Folding Chair",
      dayRateCents: 300,
      currency: "usd",
      availableQuantity: 40,
    },
  ],
  tasks: [{ id: "task_web", taskType: "WEB_BUILD" }],
};

const validHtml = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color:#111;background:#fff}@media(prefers-color-scheme:dark){:root{color:#fff;background:#111}}
@media(prefers-reduced-motion:reduce){*{animation:none}}
h1{font-size:1.08rem}
</style></head><body><main><h1>BrightDay Rentals</h1><img src="https://images.unsplash.com/photo-verified" alt="Folding chairs arranged for a local event"><p>Folding Chair</p><p>$3.00 USD per day</p><p>40 available</p><address>10 Market Street, 555-0100, hello@brightday.example</address><form id="checkout"><input name="item_chair" type="number"><button>Reserve</button></form><p>Simple local event rentals with source-grounded prices and contact details.</p><p>Choose dates and quantities before secure Stripe test checkout.</p></main><script>
document.querySelector('#checkout').addEventListener('submit',async(e)=>{e.preventDefault();await fetch('https://agency.example/api/checkout',{method:'POST',headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({customer:{name:'Test Customer',email:'test@example.com'},startDate:'2026-08-15',endDate:'2026-08-16',items:[{itemId:'item_chair',quantity:1}]})})});
if(location.search.includes('checkout=success')){fetch('https://agency.example/api/orders/'+new URLSearchParams(location.search).get('reservation_id')).then(response=>response.json()).then(result=>{if(result.order?.status==='PAID')document.body.dataset.orderConfirmed='true'})}
</script></body></html>`;

const imageFetch = async () => new Response("image", {
  status: 200,
  headers: { "content-type": "image/jpeg" },
});

test("SiteService validates grounded checkout HTML before persistence", async () => {
  const calls = [];
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: {
      async readRunContext() {
        return context;
      },
      async persistSiteArtifact(input) {
        calls.push(input);
        return { artifactId: "site_1", replayed: false };
      },
    },
  });
  const result = await service.persist({
    tenantId: "tenant_demo",
    runId: "run_demo",
    html: validHtml,
    publicApiBaseUrl: "https://agency.example",
    review: { status: "PASSED", feedback: [] },
    revisionNumber: 1,
    idempotencyKey: "site-v1",
  });
  assert.equal(result.artifactId, "site_1");
  assert.equal(calls[0].publicApiBaseUrl, "https://agency.example");
  assert.match(calls[0].html, /http-equiv="Content-Security-Policy"/);
  assert.match(calls[0].html, /connect-src https:\/\/agency\.example/);
  assert.match(calls[0].html, /img-src 'self' https:\/\/images\.unsplash\.com/);
});

test("SiteService rejects an LLM-supplied Content Security Policy", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace(
        "<head>",
        '<head><meta http-equiv="Content-Security-Policy" content="default-src *">',
      ),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /leave Content Security Policy to Tier 3/,
  );
});

test("SiteService rejects invented social proof before persistence", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("Simple local event rentals", "Customers love us for local event rentals"),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    ValidationError,
  );
});

test("SiteService rejects a price not found in the authoritative catalog", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("</main>", "<p>Premium $4.00 USD option</p></main>"),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /price not found in the catalog/,
  );
});

test("SiteService rejects a redirect-only checkout success screen", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("result.order?.status==='PAID'", "location.search.includes('success')"),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /persisted PAID order response/,
  );
});

test("SiteService rejects checkout HTML with flat customer fields", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace(
        "customer:{name:'Test Customer',email:'test@example.com'}",
        "customerName:'Test Customer',customerEmail:'test@example.com'",
      ),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-flat-customer",
    }),
    /must send customer: \{ name, email \}/,
  );
});

test("SiteService rejects image hosts outside the Tier 3 allow-list", async () => {
  const service = new SiteService({
    fetchImpl: async () => { throw new Error("must not fetch an unapproved host"); },
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("images.unsplash.com", "untrusted.example"),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /not allow-listed/,
  );
});

test("SiteService rejects a non-image response from an allow-listed host", async () => {
  const service = new SiteService({
    fetchImpl: async () => new Response("not an image", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml,
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /valid image response/,
  );
});

test("SiteService rejects unverified responsive image candidates", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace(
        'alt="Folding chairs arranged for a local event"',
        'srcset="https://images.unsplash.com/photo-other 2x" alt="Folding chairs arranged for a local event"',
      ),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-v1",
    }),
    /only verified img src URLs/,
  );
});

test("SiteService rejects ungrounded navigation and remote executable resources", async () => {
  const service = new SiteService({
    fetchImpl: imageFetch,
    repository: { async readRunContext() { return context; } },
  });
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("</main>", '<a href="https://untrusted.example">More</a></main>'),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-link-v1",
    }),
    /unsupported or ungrounded link/,
  );
  await assert.rejects(
    service.persist({
      tenantId: "tenant_demo",
      runId: "run_demo",
      html: validHtml.replace("<script>", '<script src="https://untrusted.example/app.js"></script><script>'),
      publicApiBaseUrl: "https://agency.example",
      review: { status: "PASSED", feedback: [] },
      revisionNumber: 1,
      idempotencyKey: "site-script-v1",
    }),
    /resources standalone/,
  );
});

test("WebBuilder uses a separate Terra review purpose and creates only a pending deploy", async () => {
  const calls = [];
  const gateClient = {
    async readRunContext() { return context; },
    async modelCall(input) {
      calls.push(input);
      return {
        callId: `call_${calls.length}`,
        outputText: JSON.stringify(calls.length === 1
          ? { html: validHtml }
          : { status: "PASSED", feedback: [] }),
      };
    },
    async persistSiteArtifact(input) {
      calls.push(input);
      return {
        artifactId: "site_1",
        projectName: "epyhia-brightday",
        files: { "index.html": validHtml },
        replayed: false,
      };
    },
    async requestDeploy(input) {
      calls.push(input);
      return { actionId: "action_deploy", approvalStatus: "PENDING", status: "PENDING" };
    },
  };
  const builder = new WebBuilder({ gateClient, publicApiBaseUrl: "https://agency.example" });
  const result = await builder.buildAndRequestDeploy({
    tenantId: "tenant_demo",
    runId: "run_demo",
    idempotencyKey: "web-v1",
    revisionFeedback: ["Make pricing easier to scan"],
  });
  assert.deepEqual(JSON.parse(calls[0].input).revisionFeedback, [
    "Make pricing easier to scan",
  ]);
  assert.equal(calls[1].purpose, "review");
  assert.equal(calls[0].maxOutputTokens, 13_000);
  assert.match(calls[0].instructions, /under 35,000 characters/);
  assert.match(calls[0].instructions, /clearly illustrative event atmosphere/);
  assert.match(calls[0].instructions, /Test order recorded as paid/);
  assert.match(calls[0].instructions, /location\.search\.includes\('checkout=success'\)/);
  assert.match(calls[0].instructions, /customer: \{ name, email \}/);
  assert.match(calls[1].instructions, /customer: \{ name, email \}/);
  assert.equal(calls[2].idempotencyKey, "web-v1:persist");
  assert.equal(calls[3].mode, "LIVE");
  assert.equal(result.deployment.approvalStatus, "PENDING");
});

test("WebBuilder recovers a passed draft without making another model call", async () => {
  const calls = [];
  const gateClient = {
    async recoverSiteArtifact(input) {
      calls.push(["recover", input]);
      return {
        draft: { html: validHtml },
        review: { status: "PASSED", feedback: [] },
        revisionNumber: 2,
      };
    },
    async persistSiteArtifact(input) {
      calls.push(["persist", input]);
      return {
        projectName: "epyhia-brightday",
        files: { "index.html": validHtml },
        replayed: false,
      };
    },
    async requestDeploy(input) {
      calls.push(["deploy", input]);
      return { action: { id: "deploy_recovered", status: "PENDING_APPROVAL" } };
    },
    async modelCall() {
      throw new Error("Recovery must not call a model");
    },
  };
  const builder = new WebBuilder({
    gateClient,
    publicApiBaseUrl: "https://agency.example",
  });

  const result = await builder.recoverReviewedBuild({
    tenantId: "tenant_demo",
    runId: "run_demo",
    idempotencyKey: "web-build:run_demo",
  });

  assert.deepEqual(calls.map(([kind]) => kind), ["recover", "persist", "deploy"]);
  assert.equal(calls[1][1].revisionNumber, 2);
  assert.equal(calls[1][1].idempotencyKey, "web-build:run_demo:persist");
  assert.equal(calls[2][1].idempotencyKey, "web-build:run_demo:deploy");
  assert.equal(result.recovered, true);
});
