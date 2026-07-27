# Learner Progress

<!-- Claude reads this at the start of each session and updates it at the end.
     Learners: you don't need to touch this — Claude maintains it. -->

## Learner profile
- Name: Naveed
- Preferred learning style: Implement-then-teach-back (Claude builds, learner explains it back, Claude probes gaps)
- Started: [date]
- Last session: 2026-07-27

## Module status

| Module | Status | Notes / weak spots |
|--------|--------|--------------------|
| 01 — Agents, ReAct & the Harness | not started | |
| 02 — Skills, Subagents & Multi-Agent Orchestration | not started | |
| 03 — Agentic RAG, Semantic Cache & Knowledge Graphs | not started | Partially covered via FDE Assignment 2: sparse vs semantic retrieval, silent retrieval failure |
| 04 — Evaluation & Guardrails | not started | Partially covered via FDE Assignment 2: guardrail placement, eval-first workflow |
| 05 — Multi-Agent Systems (MCP · A2A · ADK) | not started | |
| 06 — Voice Agents | in progress | FDE Assignment 2 built end to end; see below |

Status values: not started · in progress · completed · needs review

## FDE Assignment 2 — Aurora Hotel Voice Agent (2026-07-22)

Built all five extensions: `get_room_service_hours` tool, parking/accessibility RAG grounding,
code-enforced medical/legal/financial guardrail, French `fr-FR` routing, five-turn latency benchmark.
Wrote `FDE_ANALYSIS.md` for objective 2.4. Suites went from 16 tests / 12 evals to 35 tests / 19 evals.

Teach-back results:

- **Strong.** Worked out unaided that the retriever is lexical rather than semantic, and correctly
  predicted "service" was the colliding token in the `room service hours` misfire.
- **Strong.** Immediately grasped that a system prompt cannot fix a decision made by deterministic
  routing underneath it, and reached the "prompt is a request, not a rule" conclusion themselves.
- **Corrected.** Initially separated tool-vs-RAG by "it's a fact and deterministic." The pet policy is
  equally a fact; the real axis is who owns the truth and how fast it changes.
- **Taught, not derived.** Did not know why a tool turn costs two model calls (decide the tool, then
  phrase the result). Worth re-checking.

## FDE Assignment 3 — Moment Search at Scale (2026-07-27)

Reviewed committed multi-source ingestion, retrieval, resilience, deployment, benchmark, and
handoff work in both repositories.
The 14 product tests and Python syntax checks pass, both assignment commits are clean, and a live
Fly query returned grounded video, paper, and deck locators in one SSE response.

Resolved the review findings in a follow-up implementation pass:

- Kept the Fly worker and both model services at 2 GB. Removed a blank secret override, separated
  Torch CLIP from ONNX BGE, and set the Fly-only text batch to 8 based on measured RSS.
- The previously dead-lettered ReAct paper resumed from its fetch and 33-page parse checkpoints and
  reached indexed with 147 chunks.
- Added complete PPTX slide rendering through LibreOffice, durable converted-PDF storage, exact slide
  deep links, cleanup, and a real shape-based deck regression test.
- Fixed kind-aware retry and document cleanup, non-idempotent database retry behavior, and
  caption-by-caption checkpoints.
- Hardened benchmark registration/search/error accounting and made batch-specific checkpoint resume
  evidence mandatory. Missing and timed-out backfill rows now count as failures.
- Corrected the automated evaluator so decoupling is reported as manual rather than failed.
- Verified 20 product tests, 5 benchmark tests, syntax checks, clean diff checks, and a live Fly SSE
  answer containing grounded video, paper, and deck citations.

## Weak spots to revisit
- Why a tool-calling turn costs two model round trips, and what that implies for latency work.
- Reads explanations faster than code — prefers seeing behaviour demonstrated over reading diffs.
  Lead with a runnable trace or table, then show the code.

## Next step
- Review and commit the current fixes, run the full product eval to produce `PRODUCT_EVAL.md`, record
  the demo, create the MomentSearch GitHub fork, push both repositories, and submit.
