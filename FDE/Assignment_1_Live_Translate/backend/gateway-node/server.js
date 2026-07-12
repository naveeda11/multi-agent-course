/*
 * FDE · Assignment 1 · Node Gateway  (the "software backend")
 * ==========================================================
 * This is the ONLY server the browser widget talks to. Its jobs:
 *   - serve the widget file at /widget.js
 *   - accept translation requests from the widget (CORS, validation)
 *   - forward them to the Python AI service
 *   - expose /health and /stats
 *   - log every request
 *
 * It is ~90% done. Find the two `TODO (YOU)` blocks and implement them.
 * Everything else works out of the box.
 *
 * Run:  npm install && npm start      (needs Node 18+ for global fetch)
 */
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const PORT = process.env.PORT || 8787;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";
// Serve the widget from the repo in local dev; fall back to a copy bundled next
// to this file when deployed (the Docker image only has the gateway dir).
const WIDGET_PATH = [
  process.env.WIDGET_PATH,
  path.join(__dirname, "..", "..", "widget", "translation-widget.js"),
  path.join(__dirname, "translation-widget.js"),
].find((p) => p && fs.existsSync(p));

const app = express();
const startedAt = Date.now();

// --- structured logging: one JSON line per event, to stdout AND gateway.log ---
const logStream = fs.createWriteStream(path.join(__dirname, "gateway.log"), { flags: "a" });
function logLine(event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level: "INFO", event, ...fields });
  console.log(line);
  logStream.write(line + "\n");
}

// --- middleware ----------------------------------------------------------
app.use(cors()); // dev: allow every origin so the widget works on any page
app.use(express.json({ limit: "1mb" }));

// Tolerate a backend URL pasted with a trailing slash (".../fly.dev/"), which
// makes the client request "//health" / "//translate". Collapse repeated
// slashes in the path so those still route correctly.
app.use((req, res, next) => {
  if (req.url.includes("//")) {
    const [pathname, query] = req.url.split("?");
    req.url = pathname.replace(/\/{2,}/g, "/") + (query ? "?" + query : "");
  }
  next();
});

/*
 * TODO (YOU) #1 - request-id + request-logging middleware.
 * Derive a trace id (reuse an inbound X-Request-Id, else generate one), echo it
 * back on the response, and log one structured line per request AFTER it
 * finishes: request_id, method, url, status, duration ms. res.on("finish") lets
 * us read the final status code and measure elapsed time.
 */
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const t0 = Date.now();
  res.on("finish", () => {
    logLine("request", {
      request_id: req.id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - t0,
    });
  });
  next();
});

// --- serve the widget to the console loader ------------------------------
app.get("/widget.js", (req, res) => {
  if (!WIDGET_PATH) return res.status(404).json({ error: "widget file not bundled" });
  res.type("application/javascript");
  res.sendFile(WIDGET_PATH);
});

// --- helper: forward a request to the Python AI service ------------------
/*
 * TODO (YOU) #2 - implement the proxy call.
 * POST `body` as JSON to `${AI_SERVICE_URL}${path}`, forwarding the trace id so
 * the AI service logs the same request_id. Return the parsed JSON response.
 * Throw on a non-2xx so callers can turn it into a 502.
 * (Node 18+ has global fetch - no import needed.)
 */
async function callAiService(path, body, requestId) {
  const res = await fetch(AI_SERVICE_URL + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI service ${res.status}${detail ? " " + detail : ""}`);
  }
  return res.json();
}

// --- routes the widget calls ---------------------------------------------
app.post("/translate", async (req, res) => {
  const { text, target } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "`text` (string) is required" });
  try {
    const data = await callAiService("/translate", { text, target: target || "es-MX" }, req.id);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "AI service error: " + err.message });
  }
});

app.post("/translate/batch", async (req, res) => {
  const { texts, target } = req.body || {};
  if (!Array.isArray(texts)) return res.status(400).json({ error: "`texts` (array) is required" });
  try {
    const data = await callAiService("/translate/batch", { texts, target: target || "es-MX" }, req.id);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "AI service error: " + err.message });
  }
});

app.get("/health", async (req, res) => {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  let ai = "unreachable";
  try {
    const r = await fetch(AI_SERVICE_URL + "/health");
    ai = r.ok ? await r.json() : "error";
  } catch (_) {}
  res.json({ status: "ok", gatewayUptimeSec: uptimeSec, aiService: ai });
});

app.get("/stats", async (req, res) => {
  try {
    const r = await fetch(AI_SERVICE_URL + "/stats");
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: "AI service error: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`FDE gateway on http://localhost:${PORT}  →  AI service ${AI_SERVICE_URL}`);
  console.log(`Widget served at http://localhost:${PORT}/widget.js`);
});
