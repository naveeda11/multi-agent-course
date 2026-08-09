# EPYHIA implementation

EPYHIA implements the approved three-tier design. Tier 1 is the only public Fly
service. Tier 2 contains the private orchestration runtime and scoped workers.
Tier 3 is the private Action Gate and the sole holder of Neon, OpenAI, Stripe,
Cloudflare, R2, and optional Vertex AI credentials.

## Implemented flows

- Deterministic, transactional run-shell creation before the first model call.
- Fixed model routing for Strategist, Web Builder, Marketer, Ops, and independent
  review calls, with conservative budget reservation, provider-bound idempotency,
  stale-call recovery, and integer-microdollar logs.
- Ops finalization into a versioned brand document, unique task plan, and
  server-authoritative rental catalog.
- Web Builder generation, deterministic source grounding, separate review, site
  persistence, authoritative catalog-currency grounding, and a payload-hash-bound
  Cloudflare deployment approval.
- Grounded marketing copy, 3–5 social drafts, launch email, storyboard, separate
  16:9 and 9:16 Veo prompts, and an independently approved $0.64 render payload.
- Stripe test-mode Checkout Sessions using catalog prices loaded inside Tier 3,
  availability locks, raw signed webhook verification, event deduplication, and a
  real `PAID` order row before the customer UI confirms an order.
- Auth0-protected administration UI plus unauthenticated public checkout and
  origin-bound order-status polling from the generated Cloudflare site. The
  admin UI also polls tenant-bound task status, preserves all clarification
  rounds, exposes model/action audit and integer cost totals, and shows the
  complete grounded marketing pack before approval.
- Tier 3 allow-lists and verifies generated-site image URLs before persistence;
  rejects remote scripts/styles/embeds and ungrounded navigation, and the live
  evaluator independently verifies the approved image responses again.
- Successful catalog, website, and video completion update their exact task rows
  and transition the run only when every planned task is complete. Video actions
  are limited to five payloads per tenant under a serialized Neon check.
- Live-evidence evaluation that checks HTTP responses and Neon rows instead of
  trusting worker status fields.
- Crash recovery that safely reclaims a stale deployment against the same stable
  project and exact content hash, while returning a stale paid-video action to
  fresh administrator approval before any additional spend. Rental periods are
  bounded to 365 days before inventory persistence or Stripe access.

## Verification

Requires Node 22.13 or newer, Python 3 for the product evaluation, and Docker for
the production-image check.

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
npm run verify:gate-schema
npm run verify:neon-onboarding
npm run verify:providers
npm run verify:deployment-access
npm run verify:r2-write
docker build -t epyhia:verify .
docker run --rm --env-file config/gate.env.example -e NODE_ENV=development \
  -e ACTION_GATE_DB_PATH=/tmp/epyhia/action-gate.sqlite \
  epyhia:verify node src/gate/server.js
```

Production Gate startup fails immediately if Neon, OpenAI, or either Stripe
sandbox key is absent. The explicit development-mode container command uses a
disposable SQLite path only for a local image smoke check; Fly always receives
the real Tier 3 values before deployment.

`verify:neon-onboarding` uses one fixed `tenant_epyhia_verification_v1` namespace.
It creates or replays the same zero-budget run and pending TEST deployment action;
it never calls a model or deploys externally.

## Deployment boundary

The namespaced Fly apps are:

- `epyhia-naveed-web`: public Tier 1
- `epyhia-naveed-runtime`: private Tier 2
- `epyhia-naveed-gate`: private Tier 3

`npm run configure:fly-secrets` stages exact secrets by tier. Provider credentials
go only to the Gate. Runtime receives only internal URLs and scoped capability
handles. Web receives only its internal Runtime URL and Auth0 application values.
The local `npm run start:*` commands apply the same explicit environment
allow-lists, so sharing one ignored `.env` never exposes Gate keys to Web or Runtime.
After those staged secrets are verified and code deployment is authorized,
`npm run deploy:fly` deploys Gate, Runtime, and Web in dependency order and checks
the public Tier 1 health response. Each demo tier is explicitly deployed with one
Machine (`--ha=false`) to avoid Fly's default spare Machine; this is not a
high-availability production topology. Once Tier 1 is healthy,
`npm run configure:stripe-webhook` creates or reuses the exact test-mode webhook,
limits it to the two checkout events EPYHIA handles, and installs its signing
secret directly on Tier 3 without printing it. Because Stripe returns that secret
only at endpoint creation, the setup first verifies Fly access and uses one stable
URL-derived Stripe idempotency key. If staging is interrupted, it can recover only
the same marked EPYHIA endpoint within a conservative 23-hour replay window;
outside that window it stops and requests the exact secret instead of creating a
duplicate or deleting an endpoint.

Generated business-site publication is not automatic. Web Builder first returns
an action ID and SHA-256 payload hash. An authenticated administrator must approve
that exact hash before Tier 3 can upload to Cloudflare and verify that the public
URL serves the exact approved HTML. Verification uses a short bounded poll to
allow Cloudflare's edge deployment to propagate without accepting stale content or
a non-HTML response.
Before persistence, Tier 3 injects a deterministic Content Security Policy that
limits browser connections to Tier 1 and image loads to the approved Unsplash host.
If a paid video attempt fails after partial provider spend, Tier 3 records that
cost and returns the action to pending approval before any retry. Video objects use
content-addressed R2 keys, so a separately approved retry cannot overwrite them.
The fixed Veo 3.1 Fast configuration is two four-second, 720p, video-only outputs;
at the provider's $0.08-per-second rate, the exact approved payload totals $0.64.
The Veo render uses the same approval pattern and remains unavailable until both
`GOOGLE_CLOUD_PROJECT` and one explicit credential source are supplied. Local
development accepts `GOOGLE_APPLICATION_CREDENTIALS`; Fly staging validates that
file and installs its JSON as `GOOGLE_CLOUD_CREDENTIALS_JSON` only on Tier 3.

## Live-demo prerequisites

- Tier 2's Fly address is private, but the default Fly organization network is
  broader than one caller. Runtime ingress therefore fails closed on every
  `/v1/` request unless Tier 1 supplies the exact bearer capability. Configure a
  distinct random 32-200 character alphanumeric
  `TIER1_RUNTIME_CAPABILITY_HANDLE` only on the Web and Runtime apps; no fallback
  is generated. The unauthenticated `/health` endpoint remains available only
  for platform checks.
- In the Auth0 application matching `CLIENT_ID`, Allowed Callback URLs must
  include exactly `https://epyhia-naveed-web.fly.dev/callback`, and Allowed
  Logout URLs must include exactly `https://epyhia-naveed-web.fly.dev`.
- A demo brief must provide the business name, contact details, and every catalog
  item's exact quantity, daily price, and currency.
- The Stripe test webhook must target
  `https://epyhia-naveed-web.fly.dev/stripe/webhook`; its exact `whsec_...` value
  belongs only in Tier 3 as `STRIPE_WEBHOOK_SECRET`.
- Paid video rendering requires the exact Google Cloud project and service-account
  credential plus the in-app approval of the payload-bound $0.64 action.

After a real test checkout completes and the order row exists, generate the
evaluation with:

```sh
python3 eval/eval.py \
  --agency-url https://epyhia-naveed-web.fly.dev \
  --business-url https://BUSINESS.pages.dev \
  --run-id RUN_ID \
  --reservation-id RESERVATION_ID
```

The evaluator does not trust application status fields alone: it retrieves the
referenced Stripe test Checkout Session and verifies its paid state, amount,
currency, reservation, and tenant metadata. It also HEAD-checks both R2 video
objects and matches their stored SHA-256 metadata to the approved Neon artifact
records. The agency check requires unauthenticated `/admin` to route through the
configured Auth0 issuer with the exact client and callback fields, then sends a
non-interactive authorization probe and requires Auth0 itself to accept and
redirect to that callback. A public admin page, wrong issuer/client/callback, or
an unsaved Auth0 allow-list therefore fails the product evaluation.
The crew trace also fails unless completed model-call costs are positive, within
the administrator-approved run budget, and no more than the authorized
2,000,000 microdollars. Action Gate evidence requires non-vacuous executed
checkout/webhook actions, one stable deployment record with every deployment
revision payload-approved, and one payload-approved video action with approver
and execution timestamps.
