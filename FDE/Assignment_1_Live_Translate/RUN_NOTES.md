# How I ran it

## LLM provider

- **Provider:** Google Gemini (`google-genai` SDK, async client)
- **Model:** `gemini-3.1-flash-lite` (fast + cheap; set via `MODEL` in the AI service `.env`, swappable)
- API key read from `.env` (`GEMINI_API_KEY`), never committed or hard-coded.

## Run locally (two services, one command each)

```bash
# 1) Python AI service  (port 8000)
cd backend/ai-service-python
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # set GEMINI_API_KEY, MODEL=gemini-3.1-flash-lite
uvicorn app:app --port 8000

# 2) Node gateway  (port 8787) - in a second terminal
cd backend/gateway-node
npm install
cp .env.example .env            # PORT=8787, AI_SERVICE_URL=http://127.0.0.1:8000
npm start
```

> Note: use `AI_SERVICE_URL=http://127.0.0.1:8000` (not `localhost`) on macOS -
> if Docker Desktop is running it binds `*:8000` on IPv6, and `localhost` can
> resolve to that instead of uvicorn.

## Verify

```bash
curl -sf localhost:8000/health && curl -sf localhost:8787/health
# run twice: 2nd is cached:true with far lower latencyMs
curl -s localhost:8787/translate -H 'content-type: application/json' \
  -d '{"text":"Good morning, welcome!","target":"es-MX"}'
python benchmark/bench.py            # SLA gate - exits 0
```

Local benchmark (through the gateway): **miss p95 733 ms · hit p95 8 ms (~97× faster) ·
hit rate 81% · 0 errors · 1429 req/s → all SLAs pass, exit 0.**

## Deployed on Fly.io

- **Gateway (public):** https://naveed-lt-gw.fly.dev  ← point the extension popup here
- **AI service (private):** `naveed-lt-ai.internal:8000` - no public IP; only the
  gateway can reach it over Fly's private network. SQLite cache lives on a
  persistent volume mounted at `/data`, so it survives restarts and redeploys.

```bash
# AI service (private): fly secrets set GEMINI_API_KEY=... ; fly deploy
# Gateway (public):     AI_SERVICE_URL=http://naveed-lt-ai.internal:8000 (in fly.toml) ; fly deploy
curl -sf https://naveed-lt-gw.fly.dev/health   # {"status":"ok", aiService: {...}}
```

Production end-to-end sanity: `"Free shipping on orders over $50."` →
`"Envío gratis en compras mayores a $50."` (miss 627 ms → cache hit 0 ms server-side).
