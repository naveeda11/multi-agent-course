import { createHash } from "node:crypto";
import express from "express";
import oidc from "express-openid-connect";
import { AppError, ValidationError } from "../shared/errors.js";
import { RuntimeClient } from "./runtime-client.js";

const { auth, requiresAuth } = oidc;
const MAX_DEMO_BUDGET_MICRODOLLARS = 2_000_000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requireIdempotencyKey(request) {
  const value = request.get("idempotency-key");
  if (!value || value.length < 3 || value.length > 200) {
    throw new ValidationError("Idempotency-Key must contain between 3 and 200 characters");
  }
  return value;
}

function tenantIdForAuth0Subject(subject) {
  return `tenant_${createHash("sha256").update(subject).digest("hex").slice(0, 24)}`;
}

export function adminPage(user) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EPYHIA Admin</title><style>:root{font-family:Inter,ui-sans-serif,system-ui;color:#17221c;background:#f5f2e9}body{margin:0}.shell{max-width:920px;margin:auto;padding:48px 24px}h1{font-size:clamp(2rem,7vw,4.5rem);line-height:.92;letter-spacing:-.06em;margin:0 0 18px}.lede{max-width:620px;color:#536057;font-size:1.05rem}.card{margin-top:32px;background:#fff;border:1px solid #d9d7ce;border-radius:22px;padding:28px;box-shadow:0 12px 40px #18221910}label{display:block;font-weight:650;margin:18px 0 7px}input,textarea{box-sizing:border-box;width:100%;padding:12px 14px;border:1px solid #87958b;border-radius:10px;font:inherit}input:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #ed6a3a;outline-offset:3px}textarea{min-height:180px;resize:vertical}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}button{margin:22px 8px 0 0;border:0;border-radius:999px;background:#c8471d;color:#fff;font-weight:750;padding:13px 22px;cursor:pointer;white-space:nowrap}button.secondary{background:#263c31}button:active{transform:translateY(1px)}button:disabled{cursor:not-allowed;opacity:.6}.status{white-space:pre-wrap;margin-top:18px;padding:14px;border-radius:12px;background:#edf2ed;display:none}.actions{display:none;margin-top:10px}.clarifications{margin-top:18px;padding:18px;border:1px solid #d9d7ce;border-radius:14px;background:#faf9f5}.clarifications:empty{display:none}.clarifications textarea{min-height:90px}.task-dashboard,.marketing-preview,.audit-dashboard{display:none;margin-top:22px;padding:18px;border:1px solid #d9d7ce;border-radius:14px;background:#faf9f5}.task-dashboard h2,.marketing-preview h2,.audit-dashboard h2{font-size:1rem;margin:0 0 10px}.task-list,.audit-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}.task-list li,.audit-list li{display:flex;justify-content:space-between;gap:16px;padding:9px 11px;border-radius:9px;background:#edf2ed}.task-state{font-weight:750}.audit-summary{font-weight:750}.audit-detail{font-family:ui-monospace,monospace;font-size:.78rem;overflow-wrap:anywhere;text-align:right}.marketing-content{display:grid;gap:10px}.marketing-content details{border:1px solid #d9d7ce;border-radius:10px;background:#fff;padding:11px 13px}.marketing-content summary{cursor:pointer;font-weight:750}.marketing-content pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.55;margin:12px 0 3px}.review-approval{margin-top:6px;padding:14px;border-radius:10px;background:#edf2ed}.review-approval p{margin:0 0 6px}.hash{overflow-wrap:anywhere;font-family:ui-monospace,monospace;font-size:.8rem}@media(max-width:650px){.grid{grid-template-columns:1fr}.shell{padding-top:30px}.card{padding:20px}button{white-space:normal}.task-list li,.audit-list li{display:block}.audit-detail{text-align:left;margin-top:4px}}</style></head>
<body><main class="shell"><p>Signed in as ${escapeHtml(user.email ?? user.name ?? "administrator")}</p><h1>Build the business, then prove it works.</h1><p class="lede">Describe the real rental business. EPYHIA will ask for missing facts instead of inventing prices or features.</p>
<form class="card" id="brief-form"><div class="grid"><div><label>Business name<input name="businessName" required></label></div><div><label>Business URL name<input name="businessSlug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required></label></div><div><label>Business email<input name="businessEmail" type="email" required></label></div><div><label>Business phone<input name="businessPhone" required></label></div></div><label>Business address<input name="businessAddress" required></label><label>Business brief<textarea name="originalBrief" required placeholder="Include every rental item, available quantity, daily price, currency, audience, and differentiators."></textarea></label><label>AI budget in dollars (maximum $2.00)<input name="budgetDollars" type="number" min="0.01" max="2" step="0.01" value="1.00" required></label><button type="submit">Create business plan</button><div class="status" id="status"></div><div class="clarifications" id="clarifications"></div><section class="task-dashboard" id="task-dashboard" aria-live="polite"><h2>Run status: <span id="run-state">EXECUTING</span></h2><ul class="task-list" id="task-list"></ul></section><section class="audit-dashboard" id="audit-dashboard" aria-live="polite"><h2>Trace and cost</h2><p class="audit-summary" id="audit-summary"></p><ul class="audit-list" id="audit-list"></ul></section><section class="marketing-preview" id="marketing-preview"><h2>Review marketing pack</h2><div class="marketing-content" id="marketing-content"></div></section><div class="actions" id="actions"><button type="button" class="secondary" id="build-site">Generate website</button><button type="button" class="secondary" id="build-marketing">Generate marketing pack</button></div></form></main>
<script>
const form=document.querySelector('#brief-form');const status=document.querySelector('#status');const actions=document.querySelector('#actions');const clarifications=document.querySelector('#clarifications');const taskDashboard=document.querySelector('#task-dashboard');const taskList=document.querySelector('#task-list');const runState=document.querySelector('#run-state');const auditDashboard=document.querySelector('#audit-dashboard');const auditSummary=document.querySelector('#audit-summary');const auditList=document.querySelector('#audit-list');const marketingPreview=document.querySelector('#marketing-preview');const marketingContent=document.querySelector('#marketing-content');let runId;let onboardingKey;let onboardingPayload;let clarificationRound=0;let clarificationHistory=[];let taskPollTimer;
async function post(path,body={},idempotencyKey=crypto.randomUUID()){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':idempotencyKey},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'The request failed.');return result}
function reviewSection(label,text){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;const content=document.createElement('pre');content.textContent=text;details.append(summary,content);return details}
function showMarketingPreview(pack,action){marketingContent.replaceChildren();marketingContent.append(reviewSection('Landing copy',pack.landingCopy));for(const [index,post] of pack.socialPosts.entries()){marketingContent.append(reviewSection('Social post '+(index+1)+' ('+post.channel+')',post.text))}marketingContent.append(reviewSection('Launch email draft',pack.launchEmail));marketingContent.append(reviewSection('Storyboard summary',pack.storyboard.summary));marketingContent.append(reviewSection('Landscape video prompt',pack.storyboard.landscapePrompt));marketingContent.append(reviewSection('Vertical video prompt',pack.storyboard.verticalPrompt));const approval=document.createElement('div');approval.className='review-approval';const estimate=document.createElement('p');estimate.textContent='Estimated render cost: $0.64 for two 4-second Fast outputs.';const hashLabel=document.createElement('p');hashLabel.className='hash';hashLabel.textContent='Exact payload hash: '+action.payloadHash;const approve=document.createElement('button');approve.type='button';approve.textContent='Approve $0.64 render';approve.addEventListener('click',async()=>{approve.disabled=true;status.textContent='Rendering the exact approved 16:9 and 9:16 video payloads...';try{const rendered=await post('/api/actions/'+encodeURIComponent(action.id)+'/approve-and-render',{payloadHash:action.payloadHash});status.textContent='Two video artifacts are stored in R2. Logged cost: $'+(rendered.execution.action.providerCostMicrodollars/1000000).toFixed(2);refreshTaskStatus()}catch(error){status.textContent=error.message;approve.disabled=false}});approval.append(estimate,hashLabel,approve);marketingContent.append(approval);marketingPreview.style.display='block'}
function auditItem(labelText,detailText){const item=document.createElement('li');const label=document.createElement('span');label.textContent=labelText;const detail=document.createElement('span');detail.className='audit-detail';detail.textContent=detailText;item.append(label,detail);return item}
function showRunAudit(audit){auditSummary.textContent='Model $'+(audit.costs.modelCostMicrodollars/1000000).toFixed(4)+' + provider $'+(audit.costs.providerCostMicrodollars/1000000).toFixed(4)+' = $'+(audit.costs.totalCostMicrodollars/1000000).toFixed(4);auditList.replaceChildren();for(const call of audit.modelCalls){auditList.append(auditItem(call.agentName+' / '+call.modelTier,call.modelId+' · '+call.status+' · '+(call.inputTokens+call.outputTokens)+' tokens · $'+(call.costMicrodollars/1000000).toFixed(4)))}for(const action of audit.actions){const failure=action.failureMessage?' · '+action.failureMessage:'';auditList.append(auditItem(action.agentName+' / '+action.actionType,action.mode+' · '+action.status+' · '+action.approvalStatus+' · '+action.payloadHash.slice(0,16)+failure))}auditDashboard.style.display='block'}
async function refreshTaskStatus(){if(!runId)return;try{const response=await fetch('/api/runs/'+encodeURIComponent(runId)+'/status');const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'Status check failed.');runState.textContent=body.status;taskList.replaceChildren();for(const task of body.tasks){const item=document.createElement('li');const label=document.createElement('span');label.textContent=task.taskType.replaceAll('_',' ');const state=document.createElement('span');state.className='task-state';state.textContent=task.status;item.append(label,state);taskList.append(item)}taskDashboard.style.display='block';try{const auditResponse=await fetch('/api/runs/'+encodeURIComponent(runId)+'/audit');const audit=await auditResponse.json();if(auditResponse.ok)showRunAudit(audit)}catch{}if(body.tasks.length&&body.tasks.every(task=>task.status==='COMPLETE')){clearInterval(taskPollTimer);taskPollTimer=undefined}}catch(error){runState.textContent='Status temporarily unavailable'}}
function startTaskPolling(){clearInterval(taskPollTimer);refreshTaskStatus();taskPollTimer=setInterval(refreshTaskStatus,2000)}
function completeOnboarding(body){clarifications.replaceChildren();if(body.status==='AWAITING_CLARIFICATION'){actions.style.display='none';taskDashboard.style.display='none';status.textContent='Answer the Strategist’s grounded follow-up questions for run '+body.shell.runId+'.';const questions=body.strategy.clarificationQuestions;questions.forEach((question,index)=>{const label=document.createElement('label');label.textContent=(index+1)+'. '+question;const answer=document.createElement('textarea');answer.required=true;answer.dataset.clarificationAnswer=String(index);label.append(answer);clarifications.append(label)});const submit=document.createElement('button');submit.type='button';submit.textContent='Continue the same run';submit.addEventListener('click',async()=>{const answers=[...clarifications.querySelectorAll('[data-clarification-answer]')].map(input=>input.value.trim());if(answers.some(answer=>!answer)){status.textContent='Please answer every clarification question.';return}submit.disabled=true;status.textContent='Applying answers to the same traceable run...';try{clarificationHistory.push(...questions.map((question,index)=>'Question: '+question+'\\nAnswer: '+answers[index]));clarificationRound+=1;const next=await post('/api/onboarding',{...onboardingPayload,clarificationAnswers:clarificationHistory,clarificationRound},onboardingKey);completeOnboarding(next)}catch(error){status.textContent=error.message;submit.disabled=false}});clarifications.append(submit);return}runId=body.shell.runId;status.textContent='Run '+runId+' is executing. Catalog items persisted: '+body.catalog.items.length;actions.style.display='block';startTaskPolling()}
form.addEventListener('submit',async(event)=>{event.preventDefault();status.style.display='block';status.textContent='Creating a traceable run...';actions.style.display='none';marketingPreview.style.display='none';clarifications.replaceChildren();try{const values=Object.fromEntries(new FormData(form));onboardingPayload={...values,approvedBudgetMicrodollars:Math.round(Number(values.budgetDollars)*1000000)};onboardingKey=crypto.randomUUID();clarificationRound=0;clarificationHistory=[];completeOnboarding(await post('/api/onboarding',onboardingPayload,onboardingKey))}catch(error){status.textContent=error.message}});
document.querySelector('#build-marketing').addEventListener('click',async()=>{status.textContent='Generating and grounding the marketing pack...';marketingPreview.style.display='none';try{const body=await post('/api/runs/'+encodeURIComponent(runId)+'/marketing');const action=body.persisted.videoAction;showMarketingPreview(body.pack,action);status.textContent='Marketing pack persisted. Review every section before approving the exact video payload.';refreshTaskStatus()}catch(error){status.textContent=error.message}});
document.querySelector('#build-site').addEventListener('click',async()=>{status.textContent='Generating and reviewing the website...';try{const body=await post('/api/runs/'+encodeURIComponent(runId)+'/web-build');const action=body.deployment.action;status.textContent='Deployment is pending your approval.\\nPayload hash: '+action.payloadHash;const approve=document.createElement('button');approve.type='button';approve.textContent='Approve exact payload and deploy';approve.addEventListener('click',async()=>{approve.disabled=true;status.textContent='Deploying the approved payload and verifying its URL...';try{const deployed=await post('/api/actions/'+encodeURIComponent(action.id)+'/approve-and-execute',{payloadHash:action.payloadHash});status.textContent='Verified live site: '+deployed.execution.deployment.liveUrl;refreshTaskStatus()}catch(error){status.textContent=error.message;approve.disabled=false}});status.append(document.createElement('br'),approve)}catch(error){status.textContent=error.message}});
</script></body></html>`;
}

export function createStripeWebhookHandler(runtimeClient) {
  return async (request, response, next) => {
    try {
      const result = await runtimeClient.forwardStripeWebhook(
        request.body,
        request.get("stripe-signature"),
      );
      response.json(result);
    } catch (error) {
      next(error);
    }
  };
}

export function createWebApp({ runtimeClient }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    auth({
      authRequired: false,
      issuerBaseURL: required("ISSUER_BASE_URL"),
      clientID: required("CLIENT_ID"),
      secret: required("SECRET"),
      baseURL: required("BASE_URL"),
      idpLogout: true,
    }),
  );

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", tier: 1 });
  });
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json", limit: "2mb" }),
    createStripeWebhookHandler(runtimeClient),
  );
  app.use(express.json({ limit: "1mb" }));
  app.get("/", (request, response) => {
    response.redirect(request.oidc?.isAuthenticated?.() ? "/admin" : "/login");
  });
  app.get("/admin", requiresAuth(), (request, response) => {
    response.type("html").send(adminPage(request.oidc.user));
  });
  app.post("/api/onboarding", requiresAuth(), async (request, response, next) => {
    try {
      const budget = request.body.approvedBudgetMicrodollars;
      if (
        !Number.isInteger(budget) ||
        budget < 1 ||
        budget > MAX_DEMO_BUDGET_MICRODOLLARS
      ) {
        throw new ValidationError("Approved AI budget must be between $0.01 and $2.00");
      }
      const subject = request.oidc.user.sub;
      const result = await runtimeClient.onboard(
        {
          tenant: {
            id: tenantIdForAuth0Subject(subject),
            name: request.oidc.user.name ?? request.oidc.user.email,
            email: request.oidc.user.email,
            businessName: request.body.businessName,
            businessSlug: request.body.businessSlug,
            businessEmail: request.body.businessEmail,
            businessPhone: request.body.businessPhone,
            businessAddress: request.body.businessAddress,
          },
          originalBrief: request.body.originalBrief,
          approvedBudgetMicrodollars: budget,
          approvedBy: subject,
          clarificationAnswers: request.body.clarificationAnswers ?? [],
          clarificationRound: request.body.clarificationRound ?? 0,
        },
        requireIdempotencyKey(request),
      );
      response.status(result.shell.replayed ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/runs/:runId/marketing", requiresAuth(), async (request, response, next) => {
    try {
      const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
      const result = await runtimeClient.createMarketingPack(
        { tenantId, runId: request.params.runId },
        requireIdempotencyKey(request),
      );
      response.status(result.persisted.replayed ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post("/api/runs/:runId/web-build", requiresAuth(), async (request, response, next) => {
    try {
      const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
      const result = await runtimeClient.buildWebsite(
        { tenantId, runId: request.params.runId },
        requireIdempotencyKey(request),
      );
      response.status(result.persisted.replayed ? 200 : 202).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/runs/:runId/status", requiresAuth(), async (request, response, next) => {
    try {
      const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
      response.json(
        await runtimeClient.readRunStatus({ tenantId, runId: request.params.runId }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/runs/:runId/audit", requiresAuth(), async (request, response, next) => {
    try {
      const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
      response.json(
        await runtimeClient.readRunAudit({ tenantId, runId: request.params.runId }),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(
    "/api/actions/:actionId/approve-and-execute",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const result = await runtimeClient.approveAndExecuteDeployment({
          actionId: request.params.actionId,
          payloadHash: request.body.payloadHash,
          approvedBy: request.oidc.user.sub,
          tenantId: tenantIdForAuth0Subject(request.oidc.user.sub),
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/actions/:actionId/approve-and-render",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const result = await runtimeClient.approveAndExecuteVideo({
          actionId: request.params.actionId,
          payloadHash: request.body.payloadHash,
          approvedBy: request.oidc.user.sub,
          tenantId: tenantIdForAuth0Subject(request.oidc.user.sub),
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.options("/api/checkout", (request, response) => {
    const origin = request.get("origin");
    if (origin) response.set("access-control-allow-origin", origin);
    response.set("access-control-allow-methods", "POST, OPTIONS");
    response.set("access-control-allow-headers", "content-type, idempotency-key");
    response.sendStatus(204);
  });
  app.post("/api/checkout", async (request, response, next) => {
    try {
      const siteOrigin = request.get("origin");
      if (!siteOrigin) throw new ValidationError("Origin is required for public checkout");
      response.set("access-control-allow-origin", siteOrigin);
      const result = await runtimeClient.createCheckoutSession(
        {
          siteOrigin,
          customer: request.body.customer,
          startDate: request.body.startDate,
          endDate: request.body.endDate,
          items: request.body.items,
          successUrl: new URL("/?checkout=success", siteOrigin).toString(),
          cancelUrl: new URL("/?checkout=cancelled", siteOrigin).toString(),
        },
        requireIdempotencyKey(request),
      );
      response.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.options("/api/orders/:reservationId", (request, response) => {
    const origin = request.get("origin");
    if (origin) response.set("access-control-allow-origin", origin);
    response.set("access-control-allow-methods", "GET, OPTIONS");
    response.sendStatus(204);
  });
  app.get("/api/orders/:reservationId", async (request, response, next) => {
    try {
      const siteOrigin = request.get("origin");
      if (!siteOrigin) throw new ValidationError("Origin is required for order status");
      response.set("access-control-allow-origin", siteOrigin);
      response.json(
        await runtimeClient.readOrderStatus(request.params.reservationId, siteOrigin),
      );
    } catch (error) {
      next(error);
    }
  });
  app.use((error, _request, response, _next) => {
    const appError = error instanceof AppError ? error : new AppError("Request failed");
    response.status(appError.status).json({
      error: { code: appError.code, message: appError.message },
    });
  });
  return app;
}

function start() {
  const app = createWebApp({
    runtimeClient: new RuntimeClient({
      baseUrl: required("RUNTIME_URL"),
      capabilityHandle: required("TIER1_RUNTIME_CAPABILITY_HANDLE"),
    }),
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, "::", () => {
    process.stdout.write(`EPYHIA web tier listening on port ${port}\n`);
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    start();
  } catch (error) {
    process.stderr.write(`EPYHIA web tier failed to start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
