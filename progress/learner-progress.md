# Learner Progress

<!-- Claude reads this at the start of each session and updates it at the end.
     Learners: you don't need to touch this — Claude maintains it. -->

## Learner profile
- Name: Naveed
- Preferred learning style: Implement-then-teach-back (Claude builds, learner explains it back, Claude probes gaps)
- Started: [date]
- Last session: 2026-07-22

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

## Weak spots to revisit
- Why a tool-calling turn costs two model round trips, and what that implies for latency work.
- Reads explanations faster than code — prefers seeing behaviour demonstrated over reading diffs.
  Lead with a runnable trace or table, then show the code.

## Next step
- Begin Module 01, or run the Assignment 2 live-provider path (`PROVIDER=openai`) and re-run the
  latency benchmark with `--no-simulate-network` to replace the assumed round trips with real ones.
