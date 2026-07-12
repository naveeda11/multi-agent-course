# Product Evaluation - Live Translate

- **Student:** Naveed Agboatwala
- **Date:** 2026-07-11
- **Video demo:** https://www.loom.com/share/4ff5f53052d849429fcdf5e2cc805a6b
- **LLM provider / model:** Google Gemini · `gemini-3.1-flash-lite`
- **Backend target:** local gateway `http://localhost:8787` · **deployed** gateway `https://naveed-lt-gw.fly.dev`

## Verdict

> This is shippable. The backend is a clean two-service split - a public Node gateway and a
> **private** Python AI service that the browser can never reach directly - and it does the one
> hard thing well: identical `(text, target)` never hits the LLM twice, and a cache hit is
> **~57× faster** than a miss (11 ms vs 626 ms p95). Translations are natural Mexican Spanish
> with correct regional register (`tapetes`, not the Castilian `alfombras`) and prices/percent/SKU
> codes preserved verbatim. Errors fail loud (LLM failure → `502`, logged), so it never ships
> English while looking healthy. The live test against homedepot.com's real homepage strings
> passed end-to-end through the deployed gateway. **Strongest part:** caching correctness +
> observability (one request id greps across both services). **Weakest part:** the cost figures
> below use the provided `sla.json` placeholder *Anthropic* prices (left unedited on purpose -
> `benchmark/` is marked do-not-edit), so the dollar amounts are conservative; real Gemini
> Flash-Lite pricing is materially lower, making the true savings larger.

**Rubric score (from `eval/report.json`):** 70 / 70 auto (+ 30 manual, grader-scored)

Auto breakdown: Widget lights up 15/15 · Caching 20/20 · Performance & SLA 15/15 ·
Logging & observability 10/10 · Service separation & contract 10/10.

## 1. Performance & cost (from `benchmark/bench.py`, cold cache)

| Metric | Result | SLA | Pass? |
|---|---|---|---|
| Cache hit p95 | 11.1 ms | ≤ 60 ms | ✅ |
| Cache miss p95 | 626 ms | ≤ 3500 ms | ✅ |
| Cache hit rate | 75.0 % | ≥ 60 % | ✅ |
| Throughput | 1268 req/s | ≥ 20 | ✅ |
| Error rate | 0.0 % | ≤ 1 % | ✅ |
| Cost per miss | $0.000161 | - | - |
| Monthly savings from cache | $60.36 | - | - |

`python benchmark/bench.py` **exits 0** - all five SLAs met. Hit vs miss speedup ≈ **57×**.

> **Cost caveat (read this):** `benchmark/sla.json` still carries the provided placeholder prices
> (`anthropic` / `claude-sonnet-4-6`, $3/$15 per Mtok). I left that file untouched because
> `AGENTS.md` marks `benchmark/` as do-not-edit. The actual provider here is **Gemini
> Flash-Lite**, whose published input/output rates are far lower, so the real cost-per-miss and
> monthly bill are **lower** than shown and the savings from caching are **larger**. Treat the
> dollar column as a conservative placeholder, not the true Gemini bill.

_(An earlier `eval.py`/`bench.py` pass ran against a fully-warm cache and reported 100% hit rate /
$0 cost - a degenerate run. The table above is from a **fresh cold cache**, which is the honest
measurement.)_

## 2. Live-website test

- **Site tested:** https://www.homedepot.com (live homepage - a real site I don't control)
- **Method:** pulled 8 real visible strings from the live DOM, then translated them by calling the
  **deployed** gateway (`https://naveed-lt-gw.fly.dev/translate/batch`) **from homedepot.com's own
  page origin** - the exact cross-origin path the widget uses.
- **Did it translate?** **Yes** - HTTP `200`, all 8 real homepage strings returned as natural es-MX
  through the deployed product. (This exercises the translation + CORS + cache path. A full visual
  DOM page-flip on a strict-CSP site is done via the **Chrome extension's background worker** by
  design - that's what the 60–90s video captures.)
- **CORS / CSP:** the gateway's `Access-Control-Allow-Origin: *` let homedepot's origin call it, and
  homedepot's CSP `connect-src` did **not** block the fetch. Note: injecting the widget `<script>`
  itself is blocked by homedepot's `script-src` (expected) - which is exactly why the extension
  exists and the console loader is only for permissive pages.
- **Batch speed:** page translation goes through `/translate/batch`, which fans its texts out to the
  LLM **concurrently** (bounded semaphore), not one-at-a-time. A fresh 20-string batch through the
  **deployed** gateway completes in **~1.3 s** total (vs ~12 s if run sequentially).
- **Cache on re-translate:** re-ran an identical batch → **all `cached: true`**, server latency
  effectively **0 ms** (client ~80–320 ms, mostly network RTT to `sjc`). Cache proven on real content.
- **Resilience:** `200` from the real origin, **0 errors**; on an LLM failure the service returns
  `502` (never the untranslated English).
- **Screenshots:** before/after visuals are in the submitted video (the extension flipping the live
  page to es-MX, then the cache-hit badge on re-translate).

### Sample translations (real homedepot.com homepage strings)

| Original (EN) | Translation (es-MX) | Numbers/codes kept? | OK? |
|---|---|---|---|
| UP TO 35% OFF Select Furniture, Rugs & Home Decor | HASTA 35% DE DESCUENTO en muebles, tapetes y decoración seleccionados | ✅ `35%` | ✅ |
| Shop All Savings | Ver todas las ofertas | - | ✅ |
| Today Only! Fast Free Delivery | ¡Solo por hoy! Envío rápido y gratis | - | ✅ |
| Air Conditioners | Aires acondicionados | - | ✅ |
| Patio Furniture | Muebles de exterior | - | ✅ |
| Building Materials | Materiales de construcción | - | ✅ |
| Log In | Iniciar sesión | - | ✅ |
| Daily Deals | Ofertas del día | - | ✅ |

Additional preservation check (workload): `Add to cart - only $1,299.00 for model SKU-4471, save 20%!`
→ `Agregar al carrito - solo $1,299.00 por el modelo SKU-4471, ¡ahorra un 20%!` - `$1,299.00`,
`SKU-4471`, `20%` all preserved; `Agregar` (es-MX) not `Añadir` (es-ES).

Multi-language (stretch goal), same English → different targets through the deployed gateway:
`Sign in` → **es-MX** `Iniciar sesión` · **pt-BR** `Entrar` · **fr** `Connexion`.

## 3. Dimension scorecard

| Dimension | Pass / Partial / Fail | Evidence |
|---|---|---|
| Translation accuracy | ✅ Pass | 8/8 live homedepot strings + workload render accurate, fluent es-MX |
| Mexican-Spanish register (es-MX) | ✅ Pass | `tapetes` (not `alfombras`), `Agregar`/`gratis` (not `Añadir`/`gratuito`); es-ES correctly differs |
| Numbers / prices / codes preserved | ✅ Pass | `$1,299.00`, `SKU-4471`, `20%`, `35%`, `$50` all verbatim |
| Page coverage | ✅ Pass | Batch translated every string sent; full DOM walk handled by the widget/extension in the video |
| Cache effectiveness | ✅ Pass | 57× local speedup; 8/8 cache hits on real content; SQLite survives restart (verified) |
| Latency vs SLA | ✅ Pass | All 5 SLAs green; `bench.py` exits 0 |
| Error handling (no silent English) | ✅ Pass | LLM failure → `502` + logged; no input-as-output fallback anywhere |
| Resilience on a real site | ✅ Pass | `200` from homedepot origin, 0 errors; CSP behavior understood and handled by the extension |
| UX polish | ✅ Pass (provided) | Widget/extension are the provided, unmodified frontend; backend adds no UX regressions |

**Observability:** `/stats` reports an accurate hit rate; gateway `/health` nests the AI service's
health; both services log one structured JSON line per request; a single `X-Request-Id` greps
end-to-end across `gateway.log` **and** `ai-service.log` (verified with both a client-supplied and an
auto-generated id).

**Deploy & hygiene:** both services on Fly.io - gateway **public** (`https://naveed-lt-gw.fly.dev`,
`/health` green), AI service **private** (no public IP, reached only via `naveed-lt-ai.internal:8000`),
SQLite on a persistent volume. `.env` / `*.db` / `*.log` / `node_modules` / `.venv` git-ignored; no
edits to `widget/` · `extension/` · `benchmark/`. Stretch goals shipped: **multi-language target**
(any BCP-47 code) and **`docker-compose.yml`** (`docker compose up` runs both, verified end-to-end).

## 4. Top fixes before shipping

1. **Own the cost model.** Move the price table out of the provided `benchmark/sla.json` (do-not-edit)
   into a config you control, set to Gemini Flash-Lite's real published rates, so the cost/savings
   numbers reflect the actual provider instead of the Anthropic placeholder.
2. **Friendly limits.** Add per-IP rate limiting on the gateway returning `429`; today an overload or
   error surfaces as the widget's generic "can't reach backend" message.
3. **In-flight de-dup.** Batch translation now fans out concurrently (this fixed a sequential-batch
   bottleneck that made a full page take ~60 s). The next refinement is coalescing concurrent
   identical misses, so a burst of the same new string in one batch makes one LLM call, not N.

---

### What to submit

- **This file** (`PRODUCT_EVAL.md`, or a PDF export) **+ the 60–90s video** showing the extension
  translating a real page into Mexican Spanish and a cache hit in the badges.
- Add the video URL at the top once recorded (currently `TODO`).
- No **Fail/Partial** rows to fix - the only caveats are the cost placeholder (item 1) and the
  video URL.
