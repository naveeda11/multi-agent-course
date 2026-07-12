"""
FDE · Assignment 1 · Python AI Service  (this is the real assignment)
=====================================================================
A small FastAPI service that translates English → Mexican Spanish with:
  - an LLM call            (lib/llm.py)
  - a two-tier cache       (lib/cache.py)  - memory + SQLite
  - structured logging     (lib/logger.py) - provided, wired for you

The Node gateway forwards the browser's requests here. You implement the
TODOs so the widget lights up. Run:

    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    cp .env.example .env          # then add your API key
    uvicorn app:app --reload --port 8000
"""
import asyncio
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from lib.cache import TwoTierCache
from lib.llm import translate_text
from lib.logger import get_logger

load_dotenv()

MODEL = os.getenv("MODEL", "gemini-2.5-flash")
DB_PATH = os.getenv("TRANSLATION_DB_PATH", "translations.db")
# Max concurrent LLM calls within a single /translate/batch. Page translation
# sends batches of ~40 nodes; running them concurrently (bounded) turns a 40×
# sequential wait into ~one round-trip. Tune down if the provider rate-limits.
BATCH_CONCURRENCY = int(os.getenv("BATCH_CONCURRENCY", "12"))

app = FastAPI(title="FDE Live Translate - AI Service")
log = get_logger("ai-service")
cache = TwoTierCache(DB_PATH)

# request/response shapes ----------------------------------------------------
class TranslateIn(BaseModel):
    text: str
    target: str = "es-MX"

class BatchIn(BaseModel):
    texts: list[str]
    target: str = "es-MX"


@app.on_event("startup")
async def startup():
    await cache.init()
    log.info("ai_service_started", extra={"model": MODEL, "db": DB_PATH})


# --- core: translate one string --------------------------------------------
async def translate_one(text: str, target: str) -> dict:
    """Translate a single string, using the cache first.

    Returns a dict shaped exactly like the widget expects:
        {"translated": str, "cached": bool, "latencyMs": int, "model": str}
    """
    text = (text or "").strip()
    if not text:
        return {"translated": "", "cached": False, "latencyMs": 0, "model": MODEL}

    t0 = time.perf_counter()

    # 1) cache first - a hit never touches the LLM
    cached_value = await cache.get(text, target)
    if cached_value is not None:
        latency = int((time.perf_counter() - t0) * 1000)
        return {"translated": cached_value, "cached": True, "latencyMs": latency, "model": MODEL}

    # 2) miss - call the LLM (this may raise, which surfaces as a 502 upstream),
    #    then store so the next identical request is a hit.
    translated = await translate_text(text, target, model=MODEL)
    await cache.set(text, target, translated, model=MODEL)

    # 3) latency is measured on both paths from the same t0
    latency = int((time.perf_counter() - t0) * 1000)
    return {"translated": translated, "cached": False, "latencyMs": latency, "model": MODEL}


def _request_id(request: Request) -> str:
    """The trace id forwarded by the gateway (falls back to '-' for direct calls)."""
    return request.headers.get("x-request-id", "-")


@app.post("/translate")
async def translate(body: TranslateIn, request: Request):
    rid = _request_id(request)
    try:
        result = await translate_one(body.text, body.target)
    except Exception as exc:  # LLM/provider failure - surface it, never swallow
        log.error("translate_error", extra={"request_id": rid, "error": str(exc), "chars": len(body.text)})
        return JSONResponse(status_code=502, content={"error": f"translation failed: {exc}"})
    log.info(
        "translate",
        extra={
            "request_id": rid,
            "cached": result["cached"],
            "latencyMs": result["latencyMs"],
            "chars": len(body.text),
        },
    )
    return result


@app.post("/translate/batch")
async def translate_batch(body: BatchIn, request: Request):
    rid = _request_id(request)
    t0 = time.perf_counter()
    sem = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def _one(text: str) -> dict:
        async with sem:
            return await translate_one(text, body.target)

    try:
        # Concurrent (bounded) - order preserved by gather. If any translation
        # fails, gather raises and we surface a 502 for the whole batch.
        results = await asyncio.gather(*(_one(t) for t in body.texts))
    except Exception as exc:  # LLM/provider failure - surface it, never swallow
        log.error("translate_batch_error", extra={"request_id": rid, "error": str(exc)})
        return JSONResponse(status_code=502, content={"error": f"translation failed: {exc}"})
    latency = int((time.perf_counter() - t0) * 1000)
    hits = sum(1 for r in results if r["cached"])
    log.info(
        "translate_batch",
        extra={"request_id": rid, "count": len(results), "hits": hits, "latencyMs": latency},
    )
    # widget expects {results: [{translated, cached}], latencyMs}
    return {"results": [{"translated": r["translated"], "cached": r["cached"]} for r in results], "latencyMs": latency}


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "cacheSize": await cache.size()}


@app.get("/stats")
async def stats():
    return await cache.stats()
