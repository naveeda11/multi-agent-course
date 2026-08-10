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

function boundInputAttributes(profile, field) {
  if (!profile) return "";
  return ` value="${escapeHtml(profile[field])}" readonly`;
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

const EPYHIA_STYLES = `
:root{color-scheme:dark;font-family:"Avenir Next","Helvetica Neue",Arial,sans-serif;--abyss:#012624;--deep:#011d1c;--kelp:#003734;--mist:#edfffe;--white:#fff;--silver:#bbc7c6;--ash:#f2f2f2;--phosphor:#fde9ff;--line:rgba(203,255,252,.16);--focus:#cbfffc}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--abyss);color:var(--silver);min-height:100dvh}body:before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background-image:radial-gradient(circle,rgba(203,255,252,.22) 1px,transparent 1px);background-size:32px 32px;opacity:.08}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}.skip-link{position:fixed;left:1rem;top:1rem;z-index:5;transform:translateY(-180%);background:var(--phosphor);color:var(--deep);padding:.75rem 1rem;border-radius:6px}.skip-link:focus{transform:translateY(0)}.site-header{position:relative;z-index:2;max-width:1440px;margin:0 auto;min-height:80px;padding:0 clamp(1.25rem,4vw,4.5rem);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid var(--line)}.wordmark{display:inline-flex;align-items:center;gap:.7rem;color:var(--white);font-size:1.08rem;font-weight:500;letter-spacing:.16em}.brand-mark{width:18px;height:18px;border:1px solid var(--mist);border-radius:50%;position:relative}.brand-mark:before,.brand-mark:after{content:"";position:absolute;border-radius:50%;background:var(--phosphor)}.brand-mark:before{width:4px;height:4px;left:2px;top:6px}.brand-mark:after{width:3px;height:3px;right:2px;top:3px}.nav-links{display:flex;align-items:center;gap:1.5rem;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase}.nav-links a{color:var(--silver);transition:color .22s ease}.nav-links a:hover{color:var(--white)}.header-actions{justify-self:end;display:flex;align-items:center;gap:1rem}.text-link{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--silver)}.text-link:hover{color:var(--white)}.primary-link,.primary-button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:.8rem 1.25rem;border:0;border-radius:6px;background:linear-gradient(90deg,#00827c 0%,#cbfffc 52%,#fad1ff 100%);color:#012624;font-size:.75rem;font-weight:500;letter-spacing:.11em;text-transform:uppercase;cursor:pointer;transition:transform .22s ease,filter .22s ease}.primary-link:hover,.primary-button:hover,button:hover{filter:brightness(1.06);transform:translateY(-2px)}.primary-link:active,.primary-button:active,button:active{transform:translateY(1px)}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:4px}.landing-main,.admin-shell{position:relative;z-index:1;max-width:1440px;margin:0 auto;padding:0 clamp(1.25rem,4vw,4.5rem)}.hero{min-height:calc(100dvh - 81px);display:grid;grid-template-columns:minmax(0,1.06fr) minmax(320px,.94fr);align-items:center;gap:clamp(2rem,7vw,7rem);padding:5rem 0 6rem}.eyebrow,.instrument-label{margin:0 0 1.2rem;color:var(--mist);font-size:.72rem;font-weight:500;letter-spacing:.15em;text-transform:uppercase}.hero h1,.admin-intro h1{max-width:850px;margin:0;color:var(--white);font-size:clamp(3.35rem,7.4vw,7.6rem);font-weight:500;line-height:.88;letter-spacing:-.052em;text-wrap:balance}.hero h1 span{color:var(--phosphor)}.hero-copy{max-width:640px;margin:2rem 0 0;color:var(--silver);font-size:clamp(1rem,1.5vw,1.22rem);line-height:1.55;text-wrap:pretty}.hero-actions{display:flex;align-items:center;gap:1.25rem;margin-top:2.2rem}.inline-link{display:inline-flex;gap:.55rem;align-items:center;color:var(--mist);font-size:.78rem;letter-spacing:.1em;text-transform:uppercase}.inline-link span{transition:transform .22s ease}.inline-link:hover span{transform:translate(3px,-3px)}.orb-stage{position:relative;min-height:520px;display:grid;place-items:center}.data-orb{position:relative;width:min(38vw,480px);aspect-ratio:1;border-radius:50%;isolation:isolate;animation:orb-drift 8s ease-in-out infinite}.data-orb:before{content:"";position:absolute;inset:5%;border-radius:50%;background:radial-gradient(circle at 32% 27%,#edfffe 0 1%,transparent 2%),radial-gradient(circle at 62% 22%,#cbfffc 0 1.2%,transparent 2.2%),radial-gradient(circle at 74% 57%,#fde9ff 0 1.1%,transparent 2.2%),radial-gradient(circle at 28% 70%,#56bdb7 0 1.1%,transparent 2.2%),radial-gradient(circle at 45% 48%,rgba(203,255,252,.22),rgba(0,55,52,.65) 42%,rgba(1,29,28,.05) 70%);background-size:42px 42px,58px 58px,49px 49px,66px 66px,100% 100%;border:1px solid rgba(203,255,252,.2)}.data-orb:after{content:"";position:absolute;inset:20%;border-radius:50%;border:1px solid rgba(253,233,255,.32);transform:rotate(-18deg)}.orbit{position:absolute;inset:0;border:1px solid rgba(203,255,252,.17);border-radius:50%;animation:orb-spin 18s linear infinite}.orbit:before{content:"";position:absolute;top:12%;left:17%;width:9px;height:9px;border-radius:50%;background:var(--phosphor)}.orbit-b{inset:10%;transform:rotate(68deg);animation-duration:13s;animation-direction:reverse}.orbit-c{inset:-5%;transform:rotate(116deg);animation-duration:24s}.orb-caption{position:absolute;right:0;bottom:8%;max-width:180px;padding:1rem;border-left:1px solid var(--line);font-size:.68rem;line-height:1.5;letter-spacing:.12em;text-transform:uppercase}.metric-strip{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.metric{padding:2.2rem 0}.metric+.metric{padding-left:2rem;border-left:1px solid var(--line)}.metric strong{display:block;color:var(--phosphor);font-size:clamp(2.3rem,5vw,4.5rem);font-weight:500;line-height:1;font-variant-numeric:tabular-nums}.metric span{display:block;margin-top:.7rem;font-size:.67rem;letter-spacing:.14em;text-transform:uppercase}.system-section{padding:9rem 0 7rem;display:grid;grid-template-columns:minmax(220px,.7fr) minmax(0,1.3fr);gap:clamp(3rem,8vw,9rem)}.section-heading{position:sticky;top:2rem;align-self:start}.section-heading h2{max-width:430px;margin:0;color:var(--white);font-size:clamp(2.7rem,5vw,5.4rem);font-weight:500;line-height:.94;letter-spacing:-.045em}.section-heading p{max-width:390px;line-height:1.55}.feature-stack{display:grid;gap:1px;background:var(--line)}.feature-row{position:relative;background:var(--abyss);padding:2.6rem 4.2rem 2.8rem 0}.feature-index{color:var(--phosphor);font-size:.7rem;letter-spacing:.12em}.feature-row h3{margin:.8rem 0;color:var(--white);font-size:clamp(1.6rem,2.8vw,2.45rem);font-weight:500;line-height:1.05;letter-spacing:-.025em}.feature-row p{max-width:620px;margin:0;line-height:1.55}.feature-arrow{position:absolute;right:0;top:2.7rem;width:34px;height:34px;display:grid;place-items:center;border-radius:6px;background:rgba(3,81,75,.62);color:var(--white)}.cta-well{margin:2rem 0 5rem;padding:clamp(4rem,10vw,8rem) clamp(1.5rem,7vw,6rem);border-radius:16px;background:var(--deep);text-align:center}.cta-well h2{max-width:900px;margin:0 auto;color:var(--white);font-size:clamp(2.8rem,6vw,6.3rem);font-weight:500;line-height:.92;letter-spacing:-.05em}.cta-well p{max-width:580px;margin:1.5rem auto 2rem;line-height:1.55}.site-footer{position:relative;z-index:1;background:var(--deep)}.footer-inner{max-width:1440px;margin:0 auto;padding:3rem clamp(1.25rem,4vw,4.5rem);display:flex;justify-content:space-between;gap:2rem;font-size:.68rem;letter-spacing:.12em;text-transform:uppercase}.admin-shell{padding-top:4.5rem;padding-bottom:6rem}.admin-intro{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(250px,.55fr);gap:clamp(2rem,8vw,8rem);align-items:end}.admin-intro h1{font-size:clamp(3.3rem,7vw,7rem)}.admin-intro .lede{max-width:650px;margin:1.7rem 0 0;font-size:1.06rem;line-height:1.55}.session-panel{align-self:end;padding:1.5rem;background:var(--deep);border-radius:16px}.session-panel p{margin:0 0 .5rem}.session-panel strong{display:block;color:var(--mist);overflow-wrap:anywhere;font-weight:500}.session-links{display:flex;gap:1rem;margin-top:1.2rem}.card{margin-top:4rem;background:var(--kelp);border-radius:16px;padding:clamp(1.5rem,4vw,3rem)}.form-heading{display:flex;justify-content:space-between;gap:2rem;align-items:end;padding-bottom:2rem;border-bottom:1px solid var(--line)}.form-heading h2{max-width:580px;margin:0;color:var(--white);font-size:clamp(2.2rem,4vw,4rem);font-weight:500;line-height:.96;letter-spacing:-.04em}.form-heading p{max-width:360px;margin:0;line-height:1.5}.field-grid,.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 1.25rem}label{display:block;margin:1.5rem 0 .55rem;color:var(--mist);font-size:.72rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase}label input,label textarea{display:block;margin-top:.6rem;text-transform:none;letter-spacing:normal}input,textarea{box-sizing:border-box;width:100%;padding:.95rem 1rem;border:1px solid rgba(203,255,252,.22);border-radius:6px;background:var(--deep);color:var(--white);transition:border-color .22s ease,background .22s ease}input:hover,textarea:hover{border-color:rgba(203,255,252,.45)}input::placeholder,textarea::placeholder{color:#82928f}textarea{min-height:190px;resize:vertical}button{margin:1.5rem .5rem 0 0;border:0;border-radius:6px;background:linear-gradient(90deg,#00827c 0%,#cbfffc 52%,#fad1ff 100%);color:var(--deep);font-size:.74rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;padding:.9rem 1.25rem;cursor:pointer;transition:transform .22s ease,filter .22s ease}button.secondary{background:var(--deep);color:var(--mist);border:1px solid var(--line)}button:disabled{cursor:not-allowed;opacity:.48}.status{white-space:pre-wrap;margin-top:1.5rem;padding:1.25rem;border-radius:6px;background:var(--deep);color:var(--mist);display:none;border-left:2px solid var(--phosphor)}.actions{display:none;margin-top:.5rem}.clarifications{margin-top:1.5rem;padding:1.5rem;border-radius:16px;background:var(--deep)}.clarifications:empty{display:none}.clarifications textarea{background:var(--abyss);min-height:90px}.task-dashboard,.marketing-preview,.audit-dashboard{display:none;margin-top:1.5rem;padding:1.5rem;border-radius:16px;background:var(--deep)}.task-dashboard h2,.marketing-preview h2,.audit-dashboard h2{color:var(--white);font-size:1.15rem;font-weight:500;margin:0 0 1rem}.task-list,.audit-list{list-style:none;margin:0;padding:0;display:grid;gap:1px;background:var(--line)}.task-list li,.audit-list li{display:flex;justify-content:space-between;gap:1rem;padding:1rem;background:var(--deep)}.task-state{color:var(--phosphor);font-weight:500;font-variant-numeric:tabular-nums}.audit-summary{color:var(--phosphor);font-size:clamp(1.5rem,3vw,2.5rem);font-variant-numeric:tabular-nums}.audit-detail{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.72rem;overflow-wrap:anywhere;text-align:right;color:var(--silver)}.marketing-content{display:grid;gap:.65rem}.marketing-content details{border:1px solid var(--line);border-radius:6px;background:var(--abyss);padding:1rem}.marketing-content summary{cursor:pointer;color:var(--mist);font-weight:500}.marketing-content pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.55;margin:1rem 0 .25rem}.review-approval{margin-top:.5rem;padding:1.25rem;border-radius:6px;background:var(--kelp)}.review-approval p{margin:0 0 .5rem}.hash{overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,monospace;font-size:.72rem}.admin-orb{width:92px;min-height:92px}.admin-orb.data-orb:before{background-size:18px 18px,22px 22px,20px 20px,24px 24px,100% 100%}.admin-orb .orb-caption{display:none}
.bound-business{margin:1.5rem 0 0;padding:1rem 1.1rem;border-left:2px solid var(--focus);background:var(--deep);color:var(--mist);line-height:1.5}.bound-business strong{color:var(--white)}input[readonly]{color:var(--mist);background:rgba(1,29,28,.72);cursor:not-allowed}.danger-zone{margin-top:2rem;padding:1.25rem;border:1px solid rgba(255,135,135,.45);border-radius:8px;background:rgba(70,12,18,.34)}.danger-zone h3{margin:0;color:#ffd6d6;font-size:1rem;font-weight:500}.danger-zone p{max-width:760px;line-height:1.5}.danger-zone button{background:#8f2633;color:#fff}.proof-dashboard{display:none;margin-top:1.5rem;padding:1.5rem;border-radius:16px;background:var(--deep)}.proof-dashboard h2{color:var(--white);font-size:1.15rem;font-weight:500;margin:0 0 1rem}.proof-copy{max-width:760px;line-height:1.55}.proof-result{display:none;margin-top:1.25rem}.proof-verdict{margin:0 0 1rem;color:var(--phosphor);font-size:clamp(1.35rem,3vw,2.2rem)}.proof-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:var(--line)}.proof-metric{min-height:122px;padding:1rem;background:var(--abyss)}.proof-metric strong{display:block;margin-bottom:.55rem;color:var(--white);font-size:1.45rem;font-weight:500;font-variant-numeric:tabular-nums}.proof-metric span{font-size:.67rem;line-height:1.45;letter-spacing:.1em;text-transform:uppercase}.proof-detail{margin:1rem 0 0;font-family:ui-monospace,SFMono-Regular,monospace;font-size:.72rem;line-height:1.55;overflow-wrap:anywhere}
.review-panel,.generation-panel,.site-preview{display:none;margin-top:1.5rem;padding:1.5rem;border-radius:16px;background:var(--deep)}.review-panel h2,.generation-panel h2,.site-preview h2{margin:0 0 .75rem;color:var(--white);font-size:1.15rem;font-weight:500}.review-copy{max-width:780px;line-height:1.55}.document-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin-top:1rem;background:var(--line)}.document-card{min-width:0;padding:1.25rem;background:var(--abyss)}.document-card h3{margin:0 0 .75rem;color:var(--mist);font-size:.78rem;letter-spacing:.1em;text-transform:uppercase}.document-card pre{max-height:420px;margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.55}.generation-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line)}.generation-item{padding:1.1rem;background:var(--abyss)}.generation-item strong{display:block;color:var(--white)}.generation-item span{display:block;margin-top:.4rem;color:var(--phosphor)}.site-frame{width:100%;height:620px;margin-top:1rem;border:1px solid var(--line);border-radius:8px;background:#fff}.approval-note{max-width:780px;line-height:1.55}.approval-complete{color:var(--phosphor)}.live-result{margin:1rem 0;padding:1rem;border-left:2px solid var(--focus);background:var(--kelp)}.live-result:empty{display:none}.live-result strong{display:block;margin-bottom:.55rem;color:var(--white)}.artifact-link{display:inline-flex;align-items:center;gap:.45rem;color:var(--mist);font-size:.76rem;letter-spacing:.09em;text-transform:uppercase;text-decoration:underline;text-underline-offset:4px}.video-gallery{display:grid;grid-template-columns:1.45fr .8fr;gap:1px;margin-top:.65rem;background:var(--line)}.video-card{min-width:0;padding:1rem;background:var(--abyss)}.video-card h3{margin:0 0 .75rem;color:var(--white);font-size:.88rem;font-weight:500}.video-card video{display:block;width:100%;max-height:520px;border-radius:6px;background:#000}.video-card .artifact-link{margin-top:.8rem}.revision-panel{display:none;margin-top:1rem;padding:1rem;border:1px solid var(--line);border-radius:8px;background:var(--abyss)}.revision-panel.open{display:block}.revision-panel label{margin-top:0}.revision-panel textarea{min-height:110px}.revision-help{max-width:760px;line-height:1.5}
.orb-stage{overflow:clip}
@keyframes orb-spin{to{rotate:360deg}}@keyframes orb-drift{0%,100%{transform:translateY(0)}50%{transform:translateY(-14px)}}
@media(max-width:850px){.site-header{grid-template-columns:1fr auto}.nav-links{display:none}.hero{grid-template-columns:1fr;padding-top:4rem}.orb-stage{min-height:390px}.data-orb{width:min(78vw,430px)}.system-section{grid-template-columns:1fr;padding-top:6rem}.section-heading{position:static}.admin-intro{grid-template-columns:1fr}.session-panel{max-width:500px}.form-heading{display:block}.form-heading p{margin-top:1rem}}
@media(max-width:620px){.site-header{padding-block:1rem}.header-actions .text-link{display:none}.hero h1,.admin-intro h1{font-size:clamp(3rem,15vw,4.7rem)}.hero-actions{align-items:flex-start;flex-direction:column}.orb-stage{min-height:320px}.metric-strip{grid-template-columns:1fr}.metric+.metric{padding-left:0;border-left:0;border-top:1px solid var(--line)}.field-grid,.grid{grid-template-columns:1fr}.card{padding:1.25rem}.task-list li,.audit-list li{display:block}.audit-detail{text-align:left;display:block;margin-top:.4rem}.footer-inner{display:block}.footer-inner span{display:block;margin-top:.7rem}}
@media(max-width:850px){.proof-grid{grid-template-columns:1fr 1fr}}
@media(max-width:850px){.document-grid,.generation-grid,.video-gallery{grid-template-columns:1fr}.site-frame{height:520px}}
@media(max-width:620px){.proof-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.data-orb,.orbit{animation:none}.primary-link,.primary-button,button,.inline-link span{transition:none}}
`;

function dataOrb(className = "") {
  return `<div class="data-orb ${className}" aria-hidden="true"><span class="orbit"></span><span class="orbit orbit-b"></span><span class="orbit orbit-c"></span><span class="orb-caption">Live actions cross one audited boundary</span></div>`;
}

export function landingPage({ authenticated = false } = {}) {
  const primaryHref = authenticated ? "/admin" : "/login";
  const primaryLabel = authenticated ? "Open workspace" : "Log in to EPYHIA";
  const sessionLink = authenticated
    ? '<a class="text-link" href="/logout">Sign out</a>'
    : '<a class="text-link" href="#system">How it works</a>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="EPYHIA is a gated multi-agent agency that builds and verifies real business infrastructure."><meta name="theme-color" content="#012624"><title>EPYHIA | Gated autonomous agency</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='29' fill='%23012624' stroke='%23cbfffc' stroke-width='2'/%3E%3Ccircle cx='24' cy='31' r='5' fill='%23fde9ff'/%3E%3Ccircle cx='42' cy='22' r='3' fill='%23cbfffc'/%3E%3C/svg%3E"><style>${EPYHIA_STYLES}</style></head>
<body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="wordmark" href="/" aria-label="EPYHIA home"><span class="brand-mark" aria-hidden="true"></span>EPYHIA</a><nav class="nav-links" aria-label="Primary navigation"><a href="#system">System</a><a href="#controls">Controls</a><a href="/health">Status</a></nav><div class="header-actions">${sessionLink}<a class="primary-link" href="${primaryHref}">${primaryLabel}</a></div></header>
<main class="landing-main" id="main"><section class="hero"><div><p class="eyebrow">Autonomous agency / controlled execution</p><h1>Build the company. <span>Prove the work.</span></h1><p class="hero-copy">EPYHIA turns a grounded business brief into a working site, a marketing pack, and test-mode commerce. Agents reason in private. Every model call, paid render, deployment, and external action crosses one audited gate.</p><div class="hero-actions"><a class="primary-link" href="${primaryHref}">${primaryLabel}</a><a class="inline-link" href="#system">Inspect the system <span aria-hidden="true">↗</span></a></div></div><div class="orb-stage">${dataOrb()}</div></section>
<section class="metric-strip" aria-label="System facts"><div class="metric"><strong>03</strong><span>isolated trust tiers</span></div><div class="metric"><strong>01</strong><span>credential boundary</span></div><div class="metric"><strong>$2</strong><span>demo model ceiling</span></div></section>
<section class="system-section" id="system"><div class="section-heading"><p class="eyebrow">The system</p><h2>Intelligence without loose authority.</h2><p>Specialists do the reasoning. Deterministic controls own persistence, approvals, idempotency, and evidence.</p></div><div class="feature-stack"><article class="feature-row"><span class="feature-index">01 / STRATEGY</span><h3>Ground the business before building.</h3><p>The Strategist resolves missing facts, produces the completed brief and brand document, then delegates the actual work.</p><span class="feature-arrow" aria-hidden="true">↗</span></article><article class="feature-row"><span class="feature-index">02 / PRODUCTION</span><h3>Turn one brief into real deliverables.</h3><p>Web Builder, Marketer, and Ops produce the site, campaign assets, catalog, and test checkout without receiving provider credentials.</p><span class="feature-arrow" aria-hidden="true">↗</span></article><article class="feature-row" id="controls"><span class="feature-index">03 / ACTION GATE</span><h3>One door to the outside world.</h3><p>Capabilities, payload-bound approvals, cost ceilings, idempotency, and audit logs govern every external action from a private credentialed tier.</p><span class="feature-arrow" aria-hidden="true">↗</span></article></div></section>
<section class="cta-well"><p class="eyebrow">Operator access</p><h2>Enter the control room.</h2><p>Authenticate to submit a real brief, inspect the agent trace, approve exact payloads, and verify the resulting business in the real world.</p><a class="primary-link" href="${primaryHref}">${primaryLabel}</a></section></main><footer class="site-footer"><div class="footer-inner"><a class="wordmark" href="/"><span class="brand-mark" aria-hidden="true"></span>EPYHIA</a><span>Three tiers. One gate. Verifiable outcomes.</span></div></footer></body></html>`;
}

export function adminPage(user, tenantProfile = null) {
  const boundBusinessNotice = tenantProfile
    ? `<p class="bound-business"><strong>${escapeHtml(tenantProfile.businessName)}</strong> is permanently bound to this Auth0 identity. Start another run by changing the brief or budget; business identity fields stay fixed to protect the existing site, catalog, and orders.</p>`
    : "";
  const deletionControls = tenantProfile
    ? '<section class="danger-zone" aria-labelledby="delete-business-heading"><h3 id="delete-business-heading">Delete business and undeploy</h3><p>Permanently removes this business’s deployed site, R2 artifacts, Stripe test associations, and EPYHIA database records. Your Auth0 login is retained so you can return and create a new business.</p><button type="button" id="delete-business">Delete business</button><p id="deletion-status" aria-live="polite"></p></section>'
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="EPYHIA operator workspace for grounded agency runs, approvals, and evidence."><meta name="theme-color" content="#012624"><title>EPYHIA | Operator workspace</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='29' fill='%23012624' stroke='%23cbfffc' stroke-width='2'/%3E%3Ccircle cx='24' cy='31' r='5' fill='%23fde9ff'/%3E%3Ccircle cx='42' cy='22' r='3' fill='%23cbfffc'/%3E%3C/svg%3E"><style>${EPYHIA_STYLES}</style></head>
<body><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><a class="wordmark" href="/" aria-label="EPYHIA home"><span class="brand-mark" aria-hidden="true"></span>EPYHIA</a><nav class="nav-links" aria-label="Workspace navigation"><a href="/">Agency home</a><a href="#brief-form">New run</a><a href="/health">Status</a></nav><div class="header-actions"><a class="text-link" href="/logout">Sign out</a><a class="primary-link" href="#brief-form">Create run</a></div></header><main class="admin-shell" id="main"><section class="admin-intro"><div><p class="eyebrow">Operator workspace / Tier 1</p><h1>Build the business. Prove the work.</h1><p class="lede">Describe the real rental business. EPYHIA asks for missing facts instead of inventing prices, claims, or features.</p></div><aside class="session-panel"><p class="instrument-label">Authenticated operator</p><strong>${escapeHtml(user.email ?? user.name ?? "administrator")}</strong><div class="session-links"><a class="inline-link" href="/">Agency home <span aria-hidden="true">↗</span></a><a class="inline-link" href="/logout">Sign out <span aria-hidden="true">↗</span></a></div></aside></section>
<form class="card" id="brief-form" data-latest-run-id="${escapeHtml(tenantProfile?.latestRunId ?? "")}"><div class="form-heading"><div><p class="instrument-label">01 / Grounded onboarding</p><h2>Define the business EPYHIA is allowed to build.</h2></div><p>Every catalog fact, price, and contact detail becomes authoritative input for the run.</p></div>${boundBusinessNotice}<div class="grid"><div><label>Business name<input name="businessName" autocomplete="organization"${boundInputAttributes(tenantProfile, "businessName")} required></label></div><div><label>Business URL name<input name="businessSlug"${boundInputAttributes(tenantProfile, "businessSlug")} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required></label></div><div><label>Business email<input name="businessEmail" type="email" autocomplete="email"${boundInputAttributes(tenantProfile, "businessEmail")} required></label></div><div><label>Business phone<input name="businessPhone" autocomplete="tel"${boundInputAttributes(tenantProfile, "businessPhone")} required></label></div></div><label>Business address<input name="businessAddress" autocomplete="street-address"${boundInputAttributes(tenantProfile, "businessAddress")} required></label><label>Business brief<textarea name="originalBrief" required placeholder="Include every rental item, available quantity, daily price, currency, audience, and differentiators."></textarea></label><label>AI budget in dollars (maximum $2.00)<input name="budgetDollars" type="number" min="0.01" max="2" step="0.01" value="1.00" required></label><button type="submit">Create business plan</button><div class="status" id="status" aria-live="polite"></div><div class="clarifications" id="clarifications"></div><section class="review-panel" id="brand-review" aria-live="polite"><h2>Review the completed strategy</h2><p class="review-copy">Approve this exact brand-document version to automatically start the website and marketing pack. This does not approve deployment or video spend.</p><div class="document-grid"><article class="document-card"><h3>Completed brief</h3><pre id="completed-brief"></pre></article><article class="document-card"><h3>Brand document</h3><pre id="brand-document"></pre></article></div><p class="hash" id="brand-hash"></p><button type="button" id="approve-brand">Approve brand and generate</button><button type="button" class="secondary" id="request-brand-changes">Request changes</button><div class="revision-panel" id="brand-revision-panel"></div></section><section class="generation-panel" id="generation-panel" aria-live="polite"><h2>Automatic generation</h2><div class="generation-grid"><div class="generation-item"><strong>Website</strong><span id="website-generation-state">Waiting for brand approval</span><button type="button" class="secondary" id="recover-website" hidden>Resume reviewed website</button></div><div class="generation-item"><strong>Marketing pack</strong><span id="marketing-generation-state">Waiting for brand approval</span></div></div></section><section class="task-dashboard" id="task-dashboard" aria-live="polite"><h2>Run status: <span id="run-state">AWAITING BRAND APPROVAL</span></h2><ul class="task-list" id="task-list"></ul></section><section class="site-preview" id="site-preview"><h2>Review website before deployment</h2><p class="approval-note">This sandboxed preview cannot publish or submit checkout. Approving below deploys the exact reviewed HTML payload.</p><iframe class="site-frame" id="site-frame" title="Generated website preview" sandbox></iframe><p class="hash" id="site-hash"></p><div class="live-result" id="site-live-result" aria-live="polite"></div><button type="button" id="approve-site">Approve website and go live</button><button type="button" class="secondary" id="request-site-changes">Request changes</button><div class="revision-panel" id="site-revision-panel"></div></section><section class="marketing-preview" id="marketing-preview"><h2>Review marketing pack</h2><p class="approval-note">Review all copy and both storyboard prompts. Pack approval is required before the separate paid-video approval becomes available.</p><div class="marketing-content" id="marketing-content"></div></section><section class="audit-dashboard" id="audit-dashboard" aria-live="polite"><h2>Trace and cost</h2><p class="audit-summary" id="audit-summary"></p><ul class="audit-list" id="audit-list"></ul></section><div class="actions" id="actions"></div>${deletionControls}</form></main>
<script>
const form=document.querySelector('#brief-form');const status=document.querySelector('#status');const actions=document.querySelector('#actions');const clarifications=document.querySelector('#clarifications');const brandReview=document.querySelector('#brand-review');const completedBrief=document.querySelector('#completed-brief');const brandDocument=document.querySelector('#brand-document');const brandHash=document.querySelector('#brand-hash');const approveBrand=document.querySelector('#approve-brand');const requestBrandChanges=document.querySelector('#request-brand-changes');const brandRevisionPanel=document.querySelector('#brand-revision-panel');const generationPanel=document.querySelector('#generation-panel');const websiteGenerationState=document.querySelector('#website-generation-state');const recoverWebsite=document.querySelector('#recover-website');const marketingGenerationState=document.querySelector('#marketing-generation-state');const sitePreview=document.querySelector('#site-preview');const siteFrame=document.querySelector('#site-frame');const siteHash=document.querySelector('#site-hash');const siteLiveResult=document.querySelector('#site-live-result');const approveSite=document.querySelector('#approve-site');const requestSiteChanges=document.querySelector('#request-site-changes');const siteRevisionPanel=document.querySelector('#site-revision-panel');const taskDashboard=document.querySelector('#task-dashboard');const taskList=document.querySelector('#task-list');const runState=document.querySelector('#run-state');const auditDashboard=document.querySelector('#audit-dashboard');const auditSummary=document.querySelector('#audit-summary');const auditList=document.querySelector('#audit-list');const marketingPreview=document.querySelector('#marketing-preview');const marketingContent=document.querySelector('#marketing-content');let runId;let onboardingKey;let onboardingPayload;let clarificationRound=0;let clarificationHistory=[];let taskPollTimer;let currentBrandDocument;let currentSiteAction;let currentVideoAction;let currentPackHash;
const deleteBusinessButton=document.querySelector('#delete-business');const deletionStatus=document.querySelector('#deletion-status');if(deleteBusinessButton){deleteBusinessButton.addEventListener('click',async()=>{if(!confirm('Delete this business, undeploy its site, and erase its artifacts, orders, and audit history? Your Auth0 login will be retained. This cannot be undone.'))return;deleteBusinessButton.disabled=true;deletionStatus.textContent='Deleting provider data, undeploying the site, and erasing the business...';try{const response=await fetch('/api/tenant',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE'})});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'Deletion failed.');location.href='/logout'}catch(error){deletionStatus.textContent=error.message;deleteBusinessButton.disabled=false}})}
const proofDashboard=document.createElement('section');proofDashboard.className='proof-dashboard';proofDashboard.id='proof-dashboard';proofDashboard.innerHTML='<h2>Idempotency proof</h2><p class="proof-copy">After one test purchase, replay the exact website build request. EPYHIA will verify that the same deployment action was returned and that site, paid-order, action, model-call, and cost totals did not increase.</p><button type="button" class="secondary" id="replay-proof">Re-run same build and verify</button><div class="proof-result" id="proof-result" aria-live="polite"></div>';actions.before(proofDashboard);const proofResult=proofDashboard.querySelector('#proof-result');const replayProof=proofDashboard.querySelector('#replay-proof');let webBuildKey;let marketingKey;let webBuildActionId;
async function post(path,body={},idempotencyKey=crypto.randomUUID()){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','idempotency-key':idempotencyKey},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'The request failed.');return result}
async function fetchRunAudit(){const response=await fetch('/api/runs/'+encodeURIComponent(runId)+'/audit');const audit=await response.json();if(!response.ok)throw new Error(audit.error?.message||'Audit check failed.');return audit}
async function fetchRunDeliverables(){const response=await fetch('/api/runs/'+encodeURIComponent(runId)+'/deliverables');const deliverables=await response.json();if(!response.ok)throw new Error(deliverables.error?.message||'Deliverable restore failed.');return deliverables}
function proofMetric(value,label){const item=document.createElement('div');item.className='proof-metric';const strong=document.createElement('strong');strong.textContent=value;const caption=document.createElement('span');caption.textContent=label;item.append(strong,caption);return item}
function showIdempotencyProof(before,after,replay){const beforeEvidence=before.idempotencyEvidence;const afterEvidence=after.idempotencyEvidence;const unchanged=beforeEvidence.deploymentCount===afterEvidence.deploymentCount&&beforeEvidence.siteArtifactCount===afterEvidence.siteArtifactCount&&beforeEvidence.paidOrderCount===afterEvidence.paidOrderCount&&beforeEvidence.duplicateOrderGroups===afterEvidence.duplicateOrderGroups&&before.modelCalls.length===after.modelCalls.length&&before.actions.length===after.actions.length&&before.costs.totalCostMicrodollars===after.costs.totalCostMicrodollars;const sameAction=replay.deployment.action.id===webBuildActionId;const passed=replay.persisted.replayed===true&&replay.deployment.replayed===true&&sameAction&&unchanged&&afterEvidence.deploymentCount===1&&afterEvidence.paidOrderCount>0&&afterEvidence.duplicateOrderGroups===0;proofResult.replaceChildren();const verdict=document.createElement('p');verdict.className='proof-verdict';verdict.textContent=passed?'PASS: replay produced no duplicate site or order.':'Replay was safe, but the full demo proof is not complete yet.';const grid=document.createElement('div');grid.className='proof-grid';grid.append(proofMetric(String(afterEvidence.deploymentCount-beforeEvidence.deploymentCount),'Site records added by replay'),proofMetric(String(afterEvidence.paidOrderCount-beforeEvidence.paidOrderCount),'Order rows added by replay'),proofMetric(String(afterEvidence.duplicateOrderGroups),'Duplicate order groups'),proofMetric('$'+((after.costs.totalCostMicrodollars-before.costs.totalCostMicrodollars)/1000000).toFixed(4),'Cost added by replay'));const detail=document.createElement('p');detail.className='proof-detail';detail.textContent='Run '+runId+' | build action '+replay.deployment.action.id+' | project '+(afterEvidence.projectName||'not deployed')+' | artifacts '+beforeEvidence.siteArtifactCount+' -> '+afterEvidence.siteArtifactCount+' | model calls '+before.modelCalls.length+' -> '+after.modelCalls.length+' | gate actions '+before.actions.length+' -> '+after.actions.length;proofResult.append(verdict,grid,detail);proofResult.style.display='block';return passed}
function reviewSection(label,text){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=label;const content=document.createElement('pre');content.textContent=text;details.append(summary,content);return details}
function openRevisionPanel(panel,{help,placeholder,submitLabel,onSubmit}){panel.replaceChildren();panel.classList.add('open');const helpText=document.createElement('p');helpText.className='revision-help';helpText.textContent=help;const label=document.createElement('label');label.textContent='What should change?';const feedback=document.createElement('textarea');feedback.placeholder=placeholder;feedback.maxLength=5000;feedback.required=true;label.append(feedback);const submit=document.createElement('button');submit.type='button';submit.textContent=submitLabel;let revisionKey;let boundFeedback;submit.addEventListener('click',async()=>{const value=feedback.value.trim();if(!value){feedback.focus();return}if(!revisionKey||boundFeedback!==value){revisionKey=crypto.randomUUID();boundFeedback=value}submit.disabled=true;try{await onSubmit(value,revisionKey);panel.classList.remove('open')}catch(error){status.style.display='block';status.textContent=error.message;submit.disabled=false}});panel.append(helpText,label,submit);feedback.focus()}
async function reviseArtifact(artifactType,feedback,revisionKey){const budgetDollars=Number(form.elements.budgetDollars.value);if(!Number.isFinite(budgetDollars)||budgetDollars<0.01||budgetDollars>2)throw new Error('Set an AI budget between $0.01 and $2.00.');const sourceRunId=runId;status.style.display='block';status.textContent=artifactType==='WEB_BUILD'?'Generating a revised website from your feedback...':'Generating a revised marketing pack from your feedback...';const result=await post('/api/runs/'+encodeURIComponent(sourceRunId)+'/artifact-revision',{artifactType,feedback,approvedBudgetMicrodollars:Math.round(budgetDollars*1000000)},revisionKey);runId=result.revision.runId;webBuildKey=revisionKey+':generate';webBuildActionId=undefined;currentBrandDocument=undefined;brandReview.style.display='none';proofDashboard.style.display='none';proofResult.style.display='none';if(artifactType==='WEB_BUILD'){marketingPreview.style.display='none';showWebsitePreview(result.generated);status.textContent='Revised website ready. Review this new version before approving deployment.'}else{sitePreview.style.display='none';showMarketingPreview(result.generated.pack,result.generated.persisted);status.textContent='Revised marketing pack ready. Review this new version before approving it.'}startTaskPolling()}
function externalArtifactLink(label,url){const link=document.createElement('a');link.className='artifact-link';link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=label+' ↗';return link}
function showLiveWebsite(url){siteLiveResult.replaceChildren();if(!url)return;const label=document.createElement('strong');label.textContent='Website deployed and verified';siteLiveResult.append(label,externalArtifactLink('Open live website',url));proofDashboard.style.display='block'}
function showVideoArtifacts(artifacts){marketingContent.querySelector('[data-video-state]')?.remove();const result=document.createElement('section');result.className='review-approval';result.dataset.videoState='complete';const heading=document.createElement('p');heading.className='approval-complete';heading.textContent='Generated videos';result.append(heading);if(!artifacts?.length){const unavailable=document.createElement('p');unavailable.textContent='The render is complete. Reopen this page to refresh the private viewing links.';result.append(unavailable);marketingContent.append(result);return}const note=document.createElement('p');note.textContent='These private viewing links are temporary and refresh whenever this page is reopened.';const gallery=document.createElement('div');gallery.className='video-gallery';for(const artifact of artifacts){const card=document.createElement('article');card.className='video-card';const title=document.createElement('h3');const landscape=artifact.artifactType==='VIDEO_LANDSCAPE';title.textContent=landscape?'Landscape video · 16:9':'Vertical video · 9:16';const video=document.createElement('video');video.controls=true;video.preload='metadata';video.playsInline=true;video.src=artifact.url;video.setAttribute('aria-label',title.textContent);card.append(title,video,externalArtifactLink('Open '+(landscape?'landscape':'vertical')+' video',artifact.url));gallery.append(card)}result.append(note,gallery);marketingContent.append(result)}
function showVideoApproval(action){currentVideoAction=action;marketingContent.querySelector('[data-video-state]')?.remove();const approval=document.createElement('div');approval.className='review-approval';approval.dataset.videoState='approval';const estimate=document.createElement('p');const hashLabel=document.createElement('p');hashLabel.className='hash';hashLabel.textContent='Exact video payload hash: '+action.payloadHash;if(action.status==='EXECUTING'){estimate.textContent='The approved landscape and vertical videos are rendering now. This section will update when both are stored.';approval.append(estimate,hashLabel);marketingContent.append(approval);return}estimate.textContent='Marketing pack approved. Optional next action: $0.64 for two 4-second Fast video outputs.';const approve=document.createElement('button');approve.type='button';approve.textContent='Approve $0.64 video render';approve.addEventListener('click',async()=>{approve.disabled=true;status.textContent='Rendering the exact approved 16:9 and 9:16 video payloads...';try{const rendered=await post('/api/actions/'+encodeURIComponent(action.id)+'/approve-and-render',{payloadHash:action.payloadHash});currentVideoAction=rendered.execution.action;status.textContent='Two video artifacts are stored in R2. Logged cost: $'+(rendered.execution.action.providerCostMicrodollars/1000000).toFixed(2);try{const latest=await fetchRunDeliverables();showVideoArtifacts(latest.marketing?.persisted?.videoArtifacts??[])}catch{showVideoArtifacts([])}refreshTaskStatus()}catch(error){status.textContent=error.message;approve.disabled=false}});approval.append(estimate,hashLabel,approve);marketingContent.append(approval)}
function showMarketingPreview(pack,persisted){currentPackHash=persisted.packHash;currentVideoAction=persisted.videoAction;marketingContent.replaceChildren();marketingContent.append(reviewSection('Landing copy',pack.landingCopy));for(const [index,post] of pack.socialPosts.entries()){marketingContent.append(reviewSection('Social post '+(index+1)+' ('+post.channel+')',post.text))}marketingContent.append(reviewSection('Launch email draft',pack.launchEmail));marketingContent.append(reviewSection('Storyboard summary',pack.storyboard.summary));marketingContent.append(reviewSection('Landscape video prompt',pack.storyboard.landscapePrompt));marketingContent.append(reviewSection('Vertical video prompt',pack.storyboard.verticalPrompt));const approval=document.createElement('div');approval.className='review-approval';const hashLabel=document.createElement('p');hashLabel.className='hash';hashLabel.textContent='Exact marketing-pack hash: '+persisted.packHash;const approve=document.createElement('button');approve.type='button';approve.textContent='Approve marketing pack';const revise=document.createElement('button');revise.type='button';revise.className='secondary';revise.textContent='Request changes';const revisionPanel=document.createElement('div');revisionPanel.className='revision-panel';revise.addEventListener('click',()=>openRevisionPanel(revisionPanel,{help:'Describe changes to this marketing pack only. Business facts and the approved brand stay unchanged.',placeholder:'Example: make the email warmer and shorten each social post.',submitLabel:'Generate revised marketing pack',onSubmit:(feedback,revisionKey)=>reviseArtifact('MARKETING_PACK',feedback,revisionKey)}));if(persisted.approvalStatus==='APPROVED'){const complete=document.createElement('p');complete.className='approval-complete';complete.textContent='Marketing pack approved.';approval.append(hashLabel,complete,revise,revisionPanel);marketingContent.append(approval);if(persisted.videoAction?.status==='EXECUTED')showVideoArtifacts(persisted.videoArtifacts);else if(persisted.videoAction)showVideoApproval(persisted.videoAction)}else{approve.addEventListener('click',async()=>{approve.disabled=true;status.textContent='Recording approval for the exact marketing pack...';try{const result=await post('/api/runs/'+encodeURIComponent(runId)+'/marketing-pack/approve',{packHash:persisted.packHash});approval.replaceChildren();const complete=document.createElement('p');complete.className='approval-complete';complete.textContent='Marketing pack approved. The paid video action remains separate.';approval.append(hashLabel,complete,revise,revisionPanel);showVideoApproval(result.videoAction);status.textContent='Marketing pack approved. Review the separate video cost before rendering.';refreshTaskStatus()}catch(error){status.textContent=error.message;approve.disabled=false}});approval.append(hashLabel,approve,revise,revisionPanel);marketingContent.append(approval)}marketingPreview.style.display='block'}
function showWebsitePreview(build){currentSiteAction=build.deployment.action;webBuildActionId=currentSiteAction.id;siteFrame.srcdoc=build.draft.html;siteHash.textContent='Exact deployment payload hash: '+currentSiteAction.payloadHash;sitePreview.style.display='block';recoverWebsite.hidden=true;approveSite.disabled=currentSiteAction.status==='EXECUTED';approveSite.textContent=currentSiteAction.status==='EXECUTED'?'Website deployed':'Approve website and go live';const recoveredUrl=build.deployment.liveUrl||(currentSiteAction.status==='EXECUTED'&&String(currentSiteAction.providerReference||'').startsWith('https://')?currentSiteAction.providerReference:null);showLiveWebsite(recoveredUrl)}
function showBrandDocument(context){currentBrandDocument=context.brandDocument;completedBrief.textContent=context.completedBrief;brandDocument.textContent=context.brandDocument.fullText;brandHash.textContent='Brand version '+context.brandDocument.version+' · exact content hash '+context.brandDocument.contentHash;brandReview.style.display='block';generationPanel.style.display='block';approveBrand.disabled=context.brandDocument.approvalStatus==='APPROVED';if(context.brandDocument.approvalStatus==='APPROVED'){approveBrand.textContent='Brand approved';websiteGenerationState.textContent='Restoring generation';marketingGenerationState.textContent='Restoring generation'}else{approveBrand.textContent='Approve brand and generate';websiteGenerationState.textContent='Waiting for brand approval';marketingGenerationState.textContent='Waiting for brand approval'}}
async function generateWebsite(){try{const build=await post('/api/runs/'+encodeURIComponent(runId)+'/web-build',{},webBuildKey);websiteGenerationState.textContent='Ready for your deployment review';showWebsitePreview(build);status.textContent='Website ready for review. Marketing continues independently if it is not ready yet.';return build}catch(error){websiteGenerationState.textContent='Failed: '+error.message;throw error}}
async function generateMarketing(){try{const result=await post('/api/runs/'+encodeURIComponent(runId)+'/marketing',{},marketingKey);marketingGenerationState.textContent='Ready for your marketing review';showMarketingPreview(result.pack,result.persisted);status.textContent='Marketing pack ready for review. Website continues independently if it is not ready yet.';return result}catch(error){marketingGenerationState.textContent='Failed: '+error.message;throw error}}
async function runGenerationBranches(){const results=await Promise.allSettled([generateWebsite(),generateMarketing()]);const completed=results.filter(result=>result.status==='fulfilled').length;if(completed===2)status.textContent='Website and marketing pack are ready. Review and approve each one independently.';else if(completed===0)status.textContent='Website and marketing generation both failed. Their messages are shown above.';else status.textContent='One deliverable is ready for review. The other branch failed and can be safely retried by reopening this page.';refreshTaskStatus();return results}
async function restorePersistedDeliverables(latest){const deliverables=await fetchRunDeliverables();if(deliverables.website){websiteGenerationState.textContent=deliverables.website.deployment.action.status==='EXECUTED'?'Deployed and verified':'Ready for your deployment review';showWebsitePreview(deliverables.website)}else{const webTask=latest?.tasks.find(task=>task.taskType==='WEB_BUILD');const pending=webTask?.status==='PENDING';websiteGenerationState.textContent=pending?'A reviewed draft can be resumed':webTask?.status||'No website output';recoverWebsite.hidden=!pending}if(deliverables.marketing){const videoReady=deliverables.marketing.persisted.videoAction?.status==='EXECUTED';marketingGenerationState.textContent=videoReady?'Approved · videos ready':'Ready for your marketing review';showMarketingPreview(deliverables.marketing.pack,deliverables.marketing.persisted)}else{const marketingTask=latest?.tasks.find(task=>task.taskType==='MARKETING_PACK');marketingGenerationState.textContent=marketingTask?.status==='PENDING'?'Generation is not complete':marketingTask?.status||'No marketing output'}const ready=Number(Boolean(deliverables.website))+Number(Boolean(deliverables.marketing));if(ready===2)status.textContent='Website and marketing deliverables restored. Completed links are shown with each deliverable.';else if(ready===1)status.textContent='One completed deliverable has been restored with its current approval state.';else status.textContent='No completed deliverable is available to review yet.';return deliverables}
async function runAutomaticGeneration(){approveBrand.disabled=true;generationPanel.style.display='block';websiteGenerationState.textContent='Generating and reviewing...';marketingGenerationState.textContent='Generating and grounding...';status.textContent='Recording brand approval before generation starts...';try{await post('/api/runs/'+encodeURIComponent(runId)+'/brand-document/approve',{brandDocumentId:currentBrandDocument.id,contentHash:currentBrandDocument.contentHash});currentBrandDocument.approvalStatus='APPROVED';approveBrand.textContent='Brand approved';status.textContent='Brand approved. Website and marketing are now running independently...';await runGenerationBranches()}catch(error){status.textContent=error.message;approveBrand.disabled=false}}
approveBrand.addEventListener('click',runAutomaticGeneration);
recoverWebsite.addEventListener('click',async()=>{recoverWebsite.disabled=true;status.textContent='Resuming the passed Website draft without another AI call...';try{const build=await post('/api/runs/'+encodeURIComponent(runId)+'/web-build/recover',{},webBuildKey);websiteGenerationState.textContent='Ready for your deployment review';showWebsitePreview(build);status.textContent='Website recovered. Review the exact draft before approving deployment.';refreshTaskStatus()}catch(error){status.textContent=error.message;recoverWebsite.disabled=false}});
requestBrandChanges.addEventListener('click',()=>openRevisionPanel(brandRevisionPanel,{help:'Describe brand or business changes. EPYHIA will use the completed brief above as the factual starting point and create a new brand-document version.',placeholder:'Example: focus on family celebrations, use a warmer voice, and replace the dark palette with cheerful neutrals.',submitLabel:'Generate revised brand',onSubmit:(feedback,revisionKey)=>startOnboarding(completedBrief.textContent+'\\n\\nRequested brand changes:\\n'+feedback,revisionKey)}));
requestSiteChanges.addEventListener('click',()=>openRevisionPanel(siteRevisionPanel,{help:'Describe changes to this website only. The approved facts, brand, catalog, and marketing pack stay unchanged.',placeholder:'Example: reduce the hero height, make pricing easier to scan, and move contact information above the FAQ.',submitLabel:'Generate revised website',onSubmit:(feedback,revisionKey)=>reviseArtifact('WEB_BUILD',feedback,revisionKey)}));
approveSite.addEventListener('click',async()=>{if(!currentSiteAction)return;approveSite.disabled=true;status.textContent='Deploying the exact reviewed website and verifying its URL...';try{const deployed=await post('/api/actions/'+encodeURIComponent(currentSiteAction.id)+'/approve-and-execute',{payloadHash:currentSiteAction.payloadHash});currentSiteAction=deployed.execution.action;approveSite.textContent='Website deployed';showLiveWebsite(deployed.execution.deployment.liveUrl);status.textContent='Website deployed and verified. Use the permanent link shown with the website preview.';refreshTaskStatus()}catch(error){status.textContent=error.message;approveSite.disabled=false}});
async function refreshVideoArtifactsIfReady(body){const marketingTask=body.tasks.find(task=>task.taskType==='MARKETING_PACK');if(currentVideoAction?.status!=='EXECUTING'||marketingTask?.status!=='COMPLETE')return;try{const deliverables=await fetchRunDeliverables();const persisted=deliverables.marketing?.persisted;if(persisted?.videoAction?.status==='EXECUTED'){currentVideoAction=persisted.videoAction;marketingGenerationState.textContent='Approved · videos ready';showVideoArtifacts(persisted.videoArtifacts)}}catch{}}
function auditItem(labelText,detailText){const item=document.createElement('li');const label=document.createElement('span');label.textContent=labelText;const detail=document.createElement('span');detail.className='audit-detail';detail.textContent=detailText;item.append(label,detail);return item}
function showRunAudit(audit){auditSummary.textContent='Model $'+(audit.costs.modelCostMicrodollars/1000000).toFixed(4)+' + provider $'+(audit.costs.providerCostMicrodollars/1000000).toFixed(4)+' = $'+(audit.costs.totalCostMicrodollars/1000000).toFixed(4);auditList.replaceChildren();for(const call of audit.modelCalls){auditList.append(auditItem(call.agentName+' / '+call.modelTier,call.modelId+' · '+call.status+' · '+(call.inputTokens+call.outputTokens)+' tokens · $'+(call.costMicrodollars/1000000).toFixed(4)))}for(const action of audit.actions){const failure=action.failureMessage?' · '+action.failureMessage:'';auditList.append(auditItem(action.agentName+' / '+action.actionType,action.mode+' · '+action.status+' · '+action.approvalStatus+' · '+action.payloadHash.slice(0,16)+failure))}auditDashboard.style.display='block'}
async function refreshTaskStatus(){if(!runId)return;try{const response=await fetch('/api/runs/'+encodeURIComponent(runId)+'/status');const body=await response.json();if(!response.ok)throw new Error(body.error?.message||'Status check failed.');if(body.brandDocument&&!currentBrandDocument)showBrandDocument(body);runState.textContent=body.status;taskList.replaceChildren();for(const task of body.tasks){const item=document.createElement('li');const label=document.createElement('span');label.textContent=task.taskType.replaceAll('_',' ');const state=document.createElement('span');state.className='task-state';state.textContent=task.status;item.append(label,state);taskList.append(item)}taskDashboard.style.display='block';try{const auditResponse=await fetch('/api/runs/'+encodeURIComponent(runId)+'/audit');const audit=await auditResponse.json();if(auditResponse.ok)showRunAudit(audit)}catch{}await refreshVideoArtifactsIfReady(body);if(body.tasks.length&&body.tasks.every(task=>task.status==='COMPLETE')){clearInterval(taskPollTimer);taskPollTimer=undefined}return body}catch(error){runState.textContent='Status temporarily unavailable';return null}}
function startTaskPolling(){clearInterval(taskPollTimer);refreshTaskStatus();taskPollTimer=setInterval(refreshTaskStatus,2000)}
function completeOnboarding(body){clarifications.replaceChildren();if(body.status==='AWAITING_CLARIFICATION'){brandReview.style.display='none';taskDashboard.style.display='none';status.textContent='Answer the Strategist’s grounded follow-up questions for run '+body.shell.runId+'.';const questions=body.strategy.clarificationQuestions;questions.forEach((question,index)=>{const label=document.createElement('label');label.textContent=(index+1)+'. '+question;const answer=document.createElement('textarea');answer.required=true;answer.dataset.clarificationAnswer=String(index);label.append(answer);clarifications.append(label)});const submit=document.createElement('button');submit.type='button';submit.textContent='Continue the same run';submit.addEventListener('click',async()=>{const answers=[...clarifications.querySelectorAll('[data-clarification-answer]')].map(input=>input.value.trim());if(answers.some(answer=>!answer)){status.textContent='Please answer every clarification question.';return}submit.disabled=true;status.textContent='Applying answers to the same traceable run...';try{clarificationHistory.push(...questions.map((question,index)=>'Question: '+question+'\\nAnswer: '+answers[index]));clarificationRound+=1;const next=await post('/api/onboarding',{...onboardingPayload,clarificationAnswers:clarificationHistory,clarificationRound},onboardingKey);completeOnboarding(next)}catch(error){status.textContent=error.message;submit.disabled=false}});clarifications.append(submit);return}runId=body.shell.runId;webBuildKey='web-build:'+runId;marketingKey='marketing:'+runId;webBuildActionId=undefined;proofDashboard.style.display='none';proofResult.style.display='none';showBrandDocument({completedBrief:body.strategy.completedBrief,brandDocument:{id:body.finalized.brandDocumentId,version:body.finalized.brandVersion,fullText:body.strategy.brandDocument,contentHash:body.finalized.brandDocumentHash,approvalStatus:body.finalized.brandApprovalStatus}});status.textContent='Catalog persisted. Review and approve the brand document before generation starts.';startTaskPolling()}
async function startOnboarding(originalBriefOverride,idempotencyKeyOverride){status.style.display='block';status.textContent='Creating a traceable run...';brandReview.style.display='none';generationPanel.style.display='none';sitePreview.style.display='none';marketingPreview.style.display='none';proofDashboard.style.display='none';recoverWebsite.hidden=true;recoverWebsite.disabled=false;clarifications.replaceChildren();currentBrandDocument=undefined;const values=Object.fromEntries(new FormData(form));if(originalBriefOverride){values.originalBrief=originalBriefOverride;form.elements.originalBrief.value=originalBriefOverride}onboardingPayload={...values,approvedBudgetMicrodollars:Math.round(Number(values.budgetDollars)*1000000)};onboardingKey=idempotencyKeyOverride||crypto.randomUUID();clarificationRound=0;clarificationHistory=[];completeOnboarding(await post('/api/onboarding',onboardingPayload,onboardingKey))}
form.addEventListener('submit',async(event)=>{event.preventDefault();try{await startOnboarding()}catch(error){status.textContent=error.message}});
async function resumeLatestRun(){if(!form.dataset.latestRunId)return;runId=form.dataset.latestRunId;webBuildKey='web-build:'+runId;marketingKey='marketing:'+runId;status.style.display='block';status.textContent='Restoring the latest run for review...';const latest=await refreshTaskStatus();if(currentBrandDocument?.approvalStatus==='PENDING'){status.textContent='Your brand document is ready for review. Nothing else will generate until you approve it.';return}if(currentBrandDocument?.approvalStatus==='APPROVED'){status.textContent='Loading the exact persisted website and marketing outputs...';try{await restorePersistedDeliverables(latest)}catch(error){status.textContent=error.message}}}
resumeLatestRun();
replayProof.addEventListener('click',async()=>{replayProof.disabled=true;proofResult.style.display='none';status.textContent='Replaying the exact persisted website build identity and comparing evidence...';try{const before=await fetchRunAudit();const replay=await post('/api/runs/'+encodeURIComponent(runId)+'/web-build/recover',{},webBuildKey);const after=await fetchRunAudit();const passed=showIdempotencyProof(before,after,replay);status.textContent=passed?'Idempotency proof passed. One site record, an unchanged paid-order total, zero duplicate groups, and no added cost.':'Replay completed without new work. Complete exactly one test purchase, then run this proof again.';showRunAudit(after)}catch(error){status.textContent=error.message}finally{replayProof.disabled=false}});
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

export function createAdminLoginHandler() {
  return (_request, response) => response.oidc.login({ returnTo: "/admin" });
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
      routes: { login: false },
    }),
  );

  app.get("/login", createAdminLoginHandler());

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
    response.type("html").send(
      landingPage({ authenticated: Boolean(request.oidc?.isAuthenticated?.()) }),
    );
  });
  app.get("/admin", requiresAuth(), async (request, response, next) => {
    try {
      const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
      const tenant = await runtimeClient.readTenantProfile({ tenantId });
      response.type("html").send(adminPage(request.oidc.user, tenant.profile));
    } catch (error) {
      next(error);
    }
  });
  app.delete("/api/tenant", requiresAuth(), async (request, response, next) => {
    try {
      const subject = request.oidc.user.sub;
      response.json(
        await runtimeClient.eraseTenant({
          tenantId: tenantIdForAuth0Subject(subject),
          auth0UserId: subject,
          confirmation: request.body.confirmation,
        }),
      );
    } catch (error) {
      next(error);
    }
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
  app.post(
    "/api/runs/:runId/web-build/recover",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
        const result = await runtimeClient.recoverWebsite(
          { tenantId, runId: request.params.runId },
          requireIdempotencyKey(request),
        );
        response.status(result.persisted.replayed ? 200 : 202).json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/runs/:runId/brand-document/approve-and-generate",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const subject = request.oidc.user.sub;
        response.json(
          await runtimeClient.approveBrandAndGenerate({
            tenantId: tenantIdForAuth0Subject(subject),
            runId: request.params.runId,
            brandDocumentId: request.body.brandDocumentId,
            contentHash: request.body.contentHash,
            approvedBy: subject,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/runs/:runId/brand-document/approve",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const subject = request.oidc.user.sub;
        response.json(
          await runtimeClient.approveBrandDocument({
            tenantId: tenantIdForAuth0Subject(subject),
            runId: request.params.runId,
            brandDocumentId: request.body.brandDocumentId,
            contentHash: request.body.contentHash,
            approvedBy: subject,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/runs/:runId/artifact-revision",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const subject = request.oidc.user.sub;
        const result = await runtimeClient.reviseArtifact(
          {
            tenantId: tenantIdForAuth0Subject(subject),
            sourceRunId: request.params.runId,
            artifactType: request.body.artifactType,
            feedback: request.body.feedback,
            approvedBudgetMicrodollars: request.body.approvedBudgetMicrodollars,
            approvedBy: subject,
          },
          requireIdempotencyKey(request),
        );
        response.status(result.revision.replayed ? 200 : 201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/api/runs/:runId/marketing-pack/approve",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const subject = request.oidc.user.sub;
        response.json(
          await runtimeClient.approveMarketingPack({
            tenantId: tenantIdForAuth0Subject(subject),
            runId: request.params.runId,
            packHash: request.body.packHash,
            approvedBy: subject,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
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
  app.get(
    "/api/runs/:runId/deliverables",
    requiresAuth(),
    async (request, response, next) => {
      try {
        const tenantId = tenantIdForAuth0Subject(request.oidc.user.sub);
        response.json(
          await runtimeClient.readRunDeliverables({
            tenantId,
            runId: request.params.runId,
          }),
        );
      } catch (error) {
        next(error);
      }
    },
  );
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
