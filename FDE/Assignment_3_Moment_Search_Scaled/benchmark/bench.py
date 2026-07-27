#!/usr/bin/env python3
"""Benchmark + SLA gate for Assignment 3 — Moment Search at Scale.

    python benchmark/bench.py                 # accept-latency, ingest-vs-search, recall
    python benchmark/bench.py --resilience    # kill a worker mid-ingest, assert no loss
    python benchmark/bench.py --json out.json # also write machine-readable results

Exits non-zero if ANY target in sla.json is missed, so it doubles as your grading
gate and a CI check.

Environment:
    BASE_URL     app under test          (default http://localhost:8100)
    ADMIN_TOKEN  bearer token for /admin/* writes
    COMPOSE_DIR  the momentsearch checkout for `docker compose` (resilience run;
                 default: ./momentsearch next to this assignment)

The recall gate expects the labeled corpus of benchmark/queries.jsonl to be
indexed for the DEFAULT tenant (the sample talks + the RAG survey, Attention,
Lewis-RAG and LLM-survey papers + the CS224N deck). The ingest/throughput/
resilience runs use a fresh bench-<epoch> tenant so content dedup never skips
them and the default tenant stays clean.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SLA = json.loads((ROOT / "benchmark" / "sla.json").read_text())
BASE = os.getenv("BASE_URL", "http://localhost:8100").rstrip("/")
ADMIN = os.getenv("ADMIN_TOKEN", "")
COMPOSE_DIR = os.getenv("COMPOSE_DIR", str(ROOT / "momentsearch"))

# Text-heavy backfill corpus (few vision-caption calls fire, so the measured
# number is ingest throughput, not LLM-caption latency). Registered under a
# fresh tenant each run.
BACKFILL = [
    ("https://arxiv.org/pdf/1810.04805", "paper", "BERT"),
    ("https://arxiv.org/pdf/2302.13971", "paper", "LLaMA"),
    ("https://arxiv.org/pdf/2201.11903", "paper", "Chain-of-Thought"),
    ("https://arxiv.org/pdf/1910.10683", "paper", "T5"),
    ("https://arxiv.org/pdf/2203.02155", "paper", "InstructGPT"),
    ("https://arxiv.org/pdf/2005.14165", "paper", "GPT-3"),
    ("https://arxiv.org/pdf/1907.11692", "paper", "RoBERTa"),
    ("https://arxiv.org/pdf/2001.08361", "paper", "Scaling Laws"),
]
RESILIENCE_BATCH = [
    ("https://arxiv.org/pdf/1706.03762", "paper", "Attention (resilience)"),
    ("https://arxiv.org/pdf/2005.11401", "paper", "Lewis RAG (resilience)"),
    ("https://arxiv.org/pdf/2312.10997", "paper", "RAG survey (resilience)"),
]


def _req(method, path, body=None, token=None, timeout=30, user=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    if user:
        req.add_header("x-user-id", user)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(), (time.perf_counter() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), (time.perf_counter() - t0) * 1000
    except Exception as e:  # noqa: BLE001
        return 0, str(e), (time.perf_counter() - t0) * 1000


def p95(xs):
    return statistics.quantiles(xs, n=100)[94] if len(xs) >= 20 else (max(xs) if xs else 0.0)


def _sse_citations(q, top_k=10, timeout=60, user=None):
    """Read /ask_stream until the citations event; return the citations list."""
    url = f"{BASE}/ask_stream?" + urllib.parse.urlencode({"q": q, "top_k": top_k})
    req = urllib.request.Request(url)
    if user:
        req.add_header("x-user-id", user)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data:"):
                    continue
                d = json.loads(line[5:].strip())
                if "citations" in d:
                    return d["citations"]
    except Exception:  # noqa: BLE001
        return None
    return None


def _sources(user=None):
    st, body, _ = _req("GET", "/admin/sources", token=ADMIN, user=user)
    if st != 200:
        return []
    return json.loads(body).get("sources", [])


def _register_batch(batch, user):
    ids = []
    for uri, kind, title in batch:
        st, body, _ = _req("POST", "/admin/documents", token=ADMIN, user=user,
                           body={"uri": uri, "kind": kind, "title": title})
        if st != 202:
            print(f"  [warn] register {title} -> {st}: {body[:120]}")
            continue
        ids.append(json.loads(body)["id"])
    return ids


def _wait_terminal(ids, user, timeout_s=1200, poll_s=10):
    """Poll /admin/sources until every id reaches a terminal status."""
    deadline = time.time() + timeout_s
    rows = {}
    while time.time() < deadline:
        rows = {s["id"]: s for s in _sources(user) if s["id"] in set(ids)}
        if len(rows) == len(ids) and all(
                s["status"] in ("indexed", "failed", "skipped") for s in rows.values()):
            return rows
        time.sleep(poll_s)
    return rows


def measure_accept_latency(n=30):
    """POST /admin/documents should enqueue-and-return fast (no parsing in-request).
    Probes use a junk tenant + junk URIs; the pipeline content-sniffs them into a
    clean `failed` within seconds. Cleanup happens at the END of the whole run
    (see _cleanup_probes) — deleting rows mid-run would orphan their already-
    scheduled queue runs and steal worker slots from the backfill measurement.
    Returns (p95_ms, user, ids)."""
    user = f"bench-accept-{int(time.time())}"
    for i in range(3):  # warm-up: steady-state accept, not TLS/pool cold start
        _req("POST", "/admin/documents", token=ADMIN, user=user,
             body={"uri": f"https://example.com/warmup_{i}.pdf",
                   "kind": "paper", "title": "warmup"})
    lat, ids = [], []
    for i in range(n):
        st, body, ms = _req("POST", "/admin/documents", token=ADMIN, user=user,
                            body={"uri": f"https://example.com/probe_{i}.pdf",
                                  "kind": "paper", "title": f"probe {i}"})
        if st == 202:
            lat.append(ms)
            ids.append(json.loads(body)["id"])
    return (p95(lat) if lat else float("inf")), user, ids


def _cleanup_probes(user, ids):
    """After all measurement: wait for probe flows to reach a terminal state
    (seconds — the content sniff fails them fast), then delete the rows."""
    rows = _wait_terminal(ids, user, timeout_s=300, poll_s=5)
    for pid in rows:
        _req("DELETE", f"/api/videos/{pid}", token=ADMIN, user=user, timeout=10)
    print(f"  cleaned up {len(rows)} accept probes")


def measure_search_p95(n=40):
    q = "what does the survey say about hybrid retrieval"
    lat = []
    for _ in range(n):
        t0 = time.perf_counter()
        cites = _sse_citations(q)
        if cites is not None:
            lat.append((time.perf_counter() - t0) * 1000)
    return p95(lat) if lat else float("inf")


def measure_recall(top_k=10):
    """Labeled queries -> does any top-k citation hit the expected source (and
    locator, page +/-1 / slide exact when labeled)?"""
    qfile = ROOT / "benchmark" / "queries.jsonl"
    queries = [json.loads(l) for l in qfile.read_text().splitlines() if l.strip()]

    indexed = {s["id"] for s in _sources() if s["status"] == "indexed"}
    missing = {q["expect"]["source_id"] for q in queries} - indexed
    if missing:
        print(f"  [warn] labeled corpus not fully indexed; missing: {sorted(missing)}")

    hits = 0
    for query in queries:
        exp = query["expect"]
        cites = _sse_citations(query["q"], top_k=top_k) or []
        hit = False
        for c in cites:
            if c.get("sourceId") != exp["source_id"]:
                continue
            loc = c.get("locator") or {}
            if "pages" in exp:
                hit = any(abs((loc.get("page") or -99) - p) <= 1 for p in exp["pages"])
            elif "slides" in exp:
                hit = loc.get("slide") in exp["slides"]
            else:
                hit = True  # video: source-level match
            if hit:
                break
        hits += hit
        print(f"  [{'hit ' if hit else 'MISS'}] {query['q'][:60]}")
    return hits / len(queries) if queries else 0.0


def run_backfill_and_measure():
    """Register the backfill under a fresh tenant, measure search p95 WHILE it
    drains, and derive throughput (total chunks / wall seconds) at completion."""
    user = f"bench-{int(time.time())}"
    t_start = time.time()
    ids = _register_batch(BACKFILL, user)
    print(f"  backfill: {len(ids)} documents registered under {user}")

    # Measure search latency while the queue is demonstrably busy.
    time.sleep(5)  # let the dispatcher admit the first docs
    during = measure_search_p95()
    busy = [s for s in _sources(user)
            if s["status"] not in ("indexed", "failed", "skipped")]
    if not busy:
        print("  [warn] backfill drained before the search sample finished; "
              "during-ingest p95 may be optimistic — use a bigger corpus")

    rows = _wait_terminal(ids, user, timeout_s=1800)
    t_end = time.time()
    done = [s for s in rows.values() if s["status"] == "indexed"]
    failed = [s for s in rows.values() if s["status"] != "indexed"]
    chunks = sum(s.get("chunks") or 0 for s in done)
    wall = max(t_end - t_start, 1e-6)
    print(f"  backfill: {len(done)}/{len(ids)} indexed, {chunks} chunks "
          f"in {wall:.0f}s" + (f", failed: {[s['id'] for s in failed]}" if failed else ""))
    for s in sorted(done, key=lambda x: x["id"]):
        print(f"    {s['title'][:30]:30s} pages={s.get('pages')} chunks={s.get('chunks')}")
    return during, chunks / wall, len(failed) / max(len(ids), 1) * 100.0


def _compose(*args):
    return subprocess.run(["docker", "compose", *args], cwd=COMPOSE_DIR,
                          capture_output=True, text=True, timeout=120)


def run_resilience():
    """Start an ingest, SIGKILL a worker mid-stream, bring a worker back (in
    prod the platform's restart policy does this), and assert: nothing lost,
    every source reaches indexed, finished stages resumed from checkpoints."""
    user = f"bench-res-{int(time.time())}"
    ids = _register_batch(RESILIENCE_BATCH, user)
    print(f"  registered {len(ids)} sources under {user}")

    killed = False
    for _ in range(60):
        rows = {s["id"]: s for s in _sources(user) if s["id"] in set(ids)}
        mid = [s for s in rows.values()
               if s["status"] in ("fetching", "parsing", "enriching", "embedding")]
        if mid:
            r = _compose("ps", "-q", "worker")
            worker = r.stdout.split()[0] if r.stdout.split() else None
            if not worker:
                print("  [fail] no worker container found to kill")
                return False
            print(f"  mid-flight ({[s['id'] for s in mid]}) — docker kill {worker[:12]}")
            subprocess.run(["docker", "kill", worker], capture_output=True, timeout=60)
            killed = True
            break
        if all(s.get("status") in ("indexed", "failed", "skipped") for s in rows.values()) \
                and len(rows) == len(ids):
            print("  [fail] batch finished before the kill — enlarge RESILIENCE_BATCH")
            return False
        time.sleep(2)
    if not killed:
        print("  [fail] never observed a mid-flight source to kill under")
        return False

    time.sleep(3)
    print("  restarting worker (platform restart-policy stand-in)")
    _compose("up", "-d", "worker")

    rows = _wait_terminal(ids, user, timeout_s=1200)
    lost = [i for i in ids if i not in rows]
    not_indexed = [s["id"] for s in rows.values() if s["status"] != "indexed"]
    ok = not lost and not not_indexed and len(rows) == len(ids)
    print(f"  terminal: {len([s for s in rows.values() if s['status']=='indexed'])}/{len(ids)} "
          f"indexed, lost={lost or 'none'}, not-indexed={not_indexed or 'none'}")

    # Evidence that finished stages were NOT redone: the fresh runs load the
    # fetch/parse checkpoints instead of re-downloading and re-parsing.
    r = _compose("logs", "worker", "--since", "15m")
    resumes = [l for l in r.stdout.splitlines() if "resume from" in l or "reconciler" in l]
    for line in resumes[-6:]:
        print(f"    {line.strip()[:120]}")
    if killed and ok and not any("resume from" in l for l in resumes):
        print("  [warn] no checkpoint-resume lines found — did the kill land "
              "before any stage finished?")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resilience", action="store_true")
    ap.add_argument("--json", dest="json_out", default="")
    args = ap.parse_args()

    results, failures = {}, []

    def gate(name, value, ok, target):
        results[name] = {"value": value, "target": target, "pass": bool(ok)}
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: {value} (target {target})")
        if not ok:
            failures.append(name)

    if args.resilience:
        no_loss = run_resilience()
        gate("no_loss_under_crash", no_loss, no_loss and SLA["no_loss_required"],
             "0 dropped, all indexed")
        return sys.exit(1 if failures else 0)

    # 1 + 4. search stays fast during a big ingest; throughput of that ingest.
    # Runs FIRST: the accept-latency probes enter the same fair queue, so
    # measuring them earlier would let the probe backlog steal worker slots
    # from the backfill window and understate throughput.
    idle = measure_search_p95()
    print(f"  idle search p95: {idle:.0f}ms")
    during, throughput, err_pct = run_backfill_and_measure()
    ratio = (during / idle) if idle else float("inf")
    gate("search_p95_during_ingest_ratio", round(ratio, 2),
         ratio <= SLA["search_p95_during_ingest_ratio_max"], SLA["search_p95_during_ingest_ratio_max"])

    # 2. recall@10 on labeled queries
    recall = measure_recall()
    gate("recall_at_10", round(recall, 2), recall >= SLA["recall_at_10_min"], SLA["recall_at_10_min"])

    # 3. accept latency (probes queue + fail-fast behind everything measured)
    a, probe_user, probe_ids = measure_accept_latency()
    gate("accept_latency_p95_ms", round(a, 1), a <= SLA["accept_latency_p95_ms"], SLA["accept_latency_p95_ms"])

    gate("ingest_throughput_chunks_per_s", round(throughput, 1),
         throughput >= SLA["ingest_throughput_min_chunks_per_s"], SLA["ingest_throughput_min_chunks_per_s"])
    gate("error_rate_pct", round(err_pct, 1), err_pct <= SLA["error_rate_max_pct"], SLA["error_rate_max_pct"])

    _cleanup_probes(probe_user, probe_ids)

    if args.json_out:
        pathlib.Path(args.json_out).write_text(json.dumps(results, indent=2))
        print(f"wrote {args.json_out}")

    print(f"\n{'ALL SLAs PASS' if not failures else 'SLA FAILURES: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
