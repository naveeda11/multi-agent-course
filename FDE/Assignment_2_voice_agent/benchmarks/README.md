# Latency Benchmark: Five Voice Turns

This directory holds the recorded output of `pipeline/latency_bench.py`.
The exercise is to measure where a voice turn's time goes, change exactly one configuration value, and compare.

## How to reproduce

```bash
cd FDE/Assignment_2_voice_agent/pipeline
python3 latency_bench.py --label before --out ../benchmarks/endpoint-600ms.json
python3 latency_bench.py --label after --endpoint-silence-ms 350 --out ../benchmarks/endpoint-350ms.json
python3 latency_bench.py --compare ../benchmarks/endpoint-600ms.json ../benchmarks/endpoint-350ms.json
```

## What is measured and what is assumed

Routing, retrieval, tool execution, and the guardrail are measured.
They run locally, so those numbers are real on any machine.

STT, LLM, and TTS are network round trips.
Against a live provider the bench measures them.
Against `PROVIDER=mock` there is no network, so the bench adds a documented per-call assumption rather than reporting a misleading zero.
Every run records its mode, and `--compare` refuses to put a measured run next to a simulated one.

Assumptions used in the runs below, all overridable on the command line:

| Assumption | Value | Flag |
|------------|-------|------|
| STT round trip | 220 ms per turn | `--stt-ms` |
| LLM round trip | 480 ms per model call | `--llm-ms` |
| TTS time to first audio | 300 ms per turn | `--tts-ms` |
| Tool execution | 40 ms per tool call | `--tool-ms` |

Endpoint silence is neither measured nor assumed.
It is exactly the configured value, because the caller waits that long by definition before the turn is committed.

## Before: endpoint silence 600 ms

| # | Turn | endpoint | stt | llm | tools | tts | **total** |
|---|------|---------:|----:|----:|------:|----:|----------:|
| 1 | policy question (retrieval) | 600 | 220 | 960 | 41 | 300 | **2121** |
| 2 | operational tool | 600 | 220 | 960 | 40 | 300 | **2120** |
| 3 | availability tool | 600 | 220 | 960 | 40 | 300 | **2120** |
| 4 | blocked advice (no model call) | 600 | 220 | 0 | 0 | 300 | **1120** |
| 5 | call close | 600 | 220 | 960 | 40 | 300 | **2120** |
| | **mean** | 600 | 220 | 768 | 32 | 300 | **1920** |

Median turn 2120 ms, slowest turn 2121 ms.

## After: endpoint silence 350 ms

| # | Turn | endpoint | stt | llm | tools | tts | **total** |
|---|------|---------:|----:|----:|------:|----:|----------:|
| 1 | policy question (retrieval) | 350 | 220 | 960 | 40 | 300 | **1870** |
| 2 | operational tool | 350 | 220 | 960 | 40 | 300 | **1870** |
| 3 | availability tool | 350 | 220 | 960 | 40 | 300 | **1870** |
| 4 | blocked advice (no model call) | 350 | 220 | 0 | 0 | 300 | **870** |
| 5 | call close | 350 | 220 | 960 | 40 | 300 | **1870** |
| | **mean** | 350 | 220 | 768 | 32 | 300 | **1670** |

Median turn 1870 ms, slowest turn 1870 ms.

## Delta

| Stage | Before | After | Delta |
|-------|-------:|------:|------:|
| endpoint | 600 | 350 | **-250** |
| stt | 220 | 220 | 0 |
| routing | 0 | 0 | 0 |
| retrieval | 0 | 0 | 0 |
| llm | 768 | 768 | 0 |
| tools | 32 | 32 | 0 |
| tts | 300 | 300 | 0 |
| **mean turn** | **1920** | **1670** | **-250** |

One configuration value removed 13.0 percent of the mean turn latency, and no other stage moved.

## What the numbers say

**The endpoint timer is the cheapest latency in the budget and the most expensive to ignore.**
At 600 ms it was 31 percent of the mean turn.
Cutting it to 350 ms cost nothing: no model change, no infrastructure, no quality tradeoff on the stages themselves.
Every other line in the table requires a vendor change, a smaller model, or streaming work.

**The saving is not free in conversation quality, only in engineering.**
A 350 ms endpoint cuts off callers who pause mid sentence to think, read a card number, or check a date.
That failure is worse than 250 ms of latency because the caller has to repeat themselves, which costs a whole extra turn of about 1900 ms plus the caller's frustration.
The right value is per deployment and should be tuned against recorded calls, not chosen from a table.
Stage 6 of `RUNBOOK.md` demonstrates both failure directions live.

**The LLM stage dominates, and it is 960 ms rather than 480 ms because a tool turn costs two model calls.**
One call decides the tool, and a second turns the tool result into speech.
That doubling is invisible in a single-number latency target and is the first thing to attack in production: stream the first model call, speak a short filler while the tool runs, or cache the second call for high-frequency intents.

**Turn 4 is the interesting one.**
The blocked-advice turn costs 870 ms instead of 1870 ms because the deterministic guardrail refuses in application code and never calls the model.
A guardrail enforced in the system prompt would have cost two model calls and could still have been talked out of the refusal.
Moving that decision out of the prompt made the agent safer, cheaper, and faster at the same time, which is rare enough to be worth naming.

## Honest limits of this benchmark

- The provider round trips are assumptions, not measurements. Re-run with `PROVIDER=openai` and `--no-simulate-network` before quoting any number in a capacity plan.
- It measures end of caller speech to response ready, not to first audible audio in the caller's ear. Network jitter, playout buffering, and the codec path add more.
- It uses five scripted turns on a healthy path. It says nothing about p95 under load, cold starts, or provider degradation.
- Real deployments should read these percentiles from `logs/voice-events.jsonl` across real calls rather than from a scripted bench.
