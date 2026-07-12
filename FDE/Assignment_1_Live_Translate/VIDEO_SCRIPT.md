# Live Translate - Demo Video Script (60-90s, technical cut)

Dense but tight: the live demo carries the video, and the Dockerfile / Fly dashboard / code appear as **fast B-roll cuts** under the narration - a 2-3 second glance each, not a dwell.
Read the **SAY** lines; the **SHOW** column is what's on screen at that moment.

Full read is ~90s. To hit ~60s, drop the beat marked **[cut for 60s]**.

## Prep (have these ready so you can cut fast, off-camera)

- **Tab A:** `https://www.homedepot.com` with the extension loaded and backend URL set to `https://naveed-lt-gw.fly.dev`.
- **Tab B:** Fly.io dashboard showing **both apps** (`naveed-lt-gw` and `naveed-lt-ai`) - ideally `naveed-lt-ai` open to where it shows **no public IP** and the volume.
- **Editor:** `backend/ai-service-python/Dockerfile`, `lib/cache.py`, `app.py` (the `/translate/batch` function), and `docker-compose.yml` open in tabs you can flick between.
- **Terminal:** pre-typed `curl -s https://naveed-lt-gw.fly.dev/health | jq` (don't run until the beat). Hit the URL once beforehand so Fly is warm.

---

### 0:00-0:12 - What it is + the split

**SHOW:** homedepot.com in English; quick cut to the Fly dashboard showing two apps.

> "Live Translate turns any English page into Mexican Spanish.
> The browser only ever talks to my Node gateway; a separate, private Python service does the actual translation and caching, so the API key stays on a server the browser can't reach."

### 0:12-0:30 - Translate a real page

**SHOW:** open the widget on homedepot, click **Translate page**, page flips to es-MX. Cursor points at a nav item and a price.

> "One click on a live Home Depot page: the widget collects the text, sends it to the gateway, and the page comes back in Mexican Spanish.
> Note the wording - 'Agregar al carrito', which is how Mexico says it, not the Spain version 'Añadir' - and prices and percentages are left unchanged."

### 0:30-0:42 - The cache hit (the key moment)

**SHOW:** click **Restore**, then **Translate page** again; point at the `cached` badges / dropped latency.

> "Restore, then translate again - the same text never gets sent to the model twice.
> The badges say cached, and the time drops from a few hundred milliseconds to basically zero."

### 0:42-0:56 - Under the hood + one-command local run

**SHOW:** flick: `cache.py` (highlight the hash key + the SQLite line) -> `app.py` `translate_batch` (highlight the parallel translate) -> `docker-compose.yml`.

> "Behind it is a two-level cache - memory first, then SQLite on disk - keyed by a hash of the text and the target language.
> A page's worth of text is translated in parallel instead of one at a time, which took a full page from about sixty seconds down to one.
> Both services are packaged as Docker images, so locally 'docker compose up' starts the whole thing with one command."

### 0:56-1:14 - The same images, deployed on Fly

**SHOW:** flick to the `Dockerfile`, then the Fly `naveed-lt-ai` page (point at **no public IP** and the **volume**), then run the pre-typed `curl .../health | jq`.

> "For the real deployment, those same two images run on Fly as two separate apps.
> The gateway is public; the AI service has no public address at all - the gateway reaches it over Fly's private network, so the browser can't touch it directly.
> Its cache sits on a disk that survives redeploys, and one request id shows up in both services' logs, so I can follow a single request from end to end."

### 1:14-1:24 - Close  **[cut for 60s: keep just the last sentence]**

**SHOW:** flash `benchmark/bench.py` output (the green SLA gate).

> "The performance checks pass - a cache hit is about fifty-seven times faster than a fresh translation - and if the model call fails, the service returns an error instead of quietly handing back the English.
> So it runs locally with one command, and it's live on the internet."

---

## Timing & delivery

- Full script ≈ 190 spoken words ≈ 85-90s. Dropping the marked beat lands it near 60s.
- Keep the code/Dockerfile/Fly cuts to ~2-3s each - the viewer should register "there's a real Dockerfile and a real Fly deploy," not read them.
- Two points worth saying clearly, because they show you understand the setup:
  - the AI service has **no public address** and is only reachable through the gateway (0:00 and 0:56);
  - **same two Docker images**, run locally by compose and in the cloud by Fly - compose is not the cloud deploy (0:42 into 0:56).
- If the page flip lags on camera, start the click and keep talking over it; don't wait in silence.
- Don't linger on the `.env` or the API key while flicking through the editor.
