"""
latency_bench.py  -  measure where a voice turn's time actually goes.

Runs a fixed script of caller turns through the real Agent and records the
per-stage cost of each turn, then lets you change one configuration value and
compare the two runs.

    python3 latency_bench.py --label before --out runs/before.json
    python3 latency_bench.py --label after --endpoint-silence-ms 350 --out runs/after.json
    python3 latency_bench.py --compare runs/before.json runs/after.json

What is measured versus assumed
-------------------------------
Routing, retrieval, tool execution, and guardrail work are always MEASURED:
they run locally, so the numbers are real on any machine.

STT, LLM, and TTS are network round trips. Against a live provider they are
measured too. Against PROVIDER=mock there is no network, so the bench ADDS a
documented per-call assumption (--stt-ms, --llm-ms, --tts-ms) instead of
reporting a misleading zero. Every run records which mode produced it, and the
comparison refuses to mix a measured run with a simulated one.

Endpoint silence is neither measured nor guessed: it is exactly the configured
value, because the caller waits that long by definition before the turn is
committed. That makes it the one line in the budget you can change for free.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

os.environ.setdefault("TTS_BACKEND", "print")

from agent import Agent  # noqa: E402
from providers import make_provider  # noqa: E402
from telemetry import TurnTrace  # noqa: E402

# Five turns chosen to exercise different paths through the same agent, because
# turn latency is a property of the path, not of the agent as a whole.
DEFAULT_SCRIPT = [
    ("policy question (retrieval)", "What is the cancellation policy?"),
    ("operational tool", "What are the room service hours?"),
    ("availability tool", "I need a room from August 12 to August 14 for two guests."),
    ("blocked advice (no model call)", "What medication should I take before check-in?"),
    ("call close", "Goodbye."),
]

# Placeholder round-trip costs for PROVIDER=mock. Replace with values measured
# against your own provider and region before quoting them in a capacity plan.
ASSUMED_STT_MS = 220.0
ASSUMED_LLM_CALL_MS = 480.0
ASSUMED_TTS_FIRST_AUDIO_MS = 300.0
ASSUMED_TOOL_CALL_MS = 40.0

STAGES = ("endpoint", "stt", "routing", "retrieval", "llm", "tools", "tts")


def _count_events(trace: TurnTrace, name: str) -> int:
    return sum(1 for event in trace.events if event["name"] == name)


def run_benchmark(
    provider_name: str,
    endpoint_silence_ms: float,
    simulate: bool,
    stt_ms: float,
    llm_ms: float,
    tts_ms: float,
    tool_ms: float,
) -> dict:
    provider = make_provider(provider_name)
    agent = Agent(provider)
    turns: list[dict] = []

    for index, (label, text) in enumerate(DEFAULT_SCRIPT, start=1):
        trace = TurnTrace(session_id="latency-bench", turn_id=f"turn-{index}")
        _, action = agent.respond(text, trace=trace)
        measured = dict(trace.timings)

        llm_calls = _count_events(trace, "llm.started")
        tool_calls = _count_events(trace, "tool.requested")

        stages = {
            # The caller waits out the endpoint timer before the turn even starts.
            "endpoint": float(endpoint_silence_ms),
            "stt": measured.get("stt", 0.0),
            "routing": measured.get("routing", 0.0),
            "retrieval": measured.get("retrieval", 0.0),
            "llm": measured.get("llm", 0.0),
            "tools": measured.get("tools", 0.0),
            "tts": measured.get("tts", 0.0),
        }
        if simulate:
            stages["stt"] += stt_ms
            stages["llm"] += llm_ms * llm_calls
            stages["tools"] += tool_ms * tool_calls
            stages["tts"] += tts_ms

        # The tools span wraps retrieval, so counting both would double-bill it.
        total = sum(stages.values()) - stages["retrieval"]
        turns.append({
            "turn": index,
            "label": label,
            "llmCalls": llm_calls,
            "toolCalls": tool_calls,
            "action": action,
            "stages": {name: round(value, 1) for name, value in stages.items()},
            "totalMs": round(total, 1),
        })

    return {
        "schemaVersion": "1.0",
        "provider": getattr(provider, "name", provider_name),
        "model": getattr(provider, "llm_model", "unknown"),
        "mode": "simulated-network" if simulate else "measured",
        "endpointSilenceMs": endpoint_silence_ms,
        "assumptions": {
            "sttMs": stt_ms, "llmCallMs": llm_ms,
            "ttsFirstAudioMs": tts_ms, "toolCallMs": tool_ms,
        } if simulate else {},
        "turns": turns,
        "summary": _summarize(turns),
    }


def _summarize(turns: list[dict]) -> dict:
    totals = [turn["totalMs"] for turn in turns]
    summary = {
        "turns": len(turns),
        "meanTotalMs": round(statistics.fmean(totals), 1),
        "medianTotalMs": round(statistics.median(totals), 1),
        "maxTotalMs": round(max(totals), 1),
        "stageMeanMs": {},
    }
    for stage in STAGES:
        values = [turn["stages"][stage] for turn in turns]
        summary["stageMeanMs"][stage] = round(statistics.fmean(values), 1)
    return summary


def print_run(run: dict, label: str) -> None:
    print(f"\n{label}  -  provider={run['provider']} mode={run['mode']} "
          f"endpointSilence={run['endpointSilenceMs']:.0f}ms")
    if run["assumptions"]:
        print("  assumed round trips: " + ", ".join(
            f"{key}={value:.0f}ms" for key, value in run["assumptions"].items()
        ))
    header = f"  {'#':<2} {'turn':<32}" + "".join(f"{stage:>10}" for stage in STAGES) + f"{'TOTAL':>10}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for turn in run["turns"]:
        row = f"  {turn['turn']:<2} {turn['label']:<32}"
        row += "".join(f"{turn['stages'][stage]:>10.0f}" for stage in STAGES)
        row += f"{turn['totalMs']:>10.0f}"
        print(row)
    summary = run["summary"]
    mean_row = f"  {'':<2} {'mean':<32}"
    mean_row += "".join(f"{summary['stageMeanMs'][stage]:>10.0f}" for stage in STAGES)
    mean_row += f"{summary['meanTotalMs']:>10.0f}"
    print("  " + "-" * (len(header) - 2))
    print(mean_row)
    print(f"  median turn {summary['medianTotalMs']:.0f} ms | "
          f"slowest turn {summary['maxTotalMs']:.0f} ms")


def compare(before: dict, after: dict) -> None:
    if before["mode"] != after["mode"]:
        raise SystemExit(
            f"Refusing to compare a {before['mode']} run with an {after['mode']} run."
        )
    print_run(before, "BEFORE")
    print_run(after, "AFTER")

    print(f"\nDELTA  (after - before), endpoint silence "
          f"{before['endpointSilenceMs']:.0f}ms -> {after['endpointSilenceMs']:.0f}ms")
    print(f"  {'stage':<16}{'before':>10}{'after':>10}{'delta':>10}")
    print("  " + "-" * 44)
    for stage in STAGES:
        before_value = before["summary"]["stageMeanMs"][stage]
        after_value = after["summary"]["stageMeanMs"][stage]
        delta = after_value - before_value
        marker = "" if abs(delta) < 0.05 else ("  <-- changed" if stage == "endpoint" else "  <-- noise")
        print(f"  {stage:<16}{before_value:>10.0f}{after_value:>10.0f}{delta:>+10.0f}{marker}")
    before_total = before["summary"]["meanTotalMs"]
    after_total = after["summary"]["meanTotalMs"]
    change = after_total - before_total
    print("  " + "-" * 44)
    print(f"  {'mean turn':<16}{before_total:>10.0f}{after_total:>10.0f}{change:>+10.0f}")
    if before_total:
        print(f"\n  {abs(change) / before_total * 100:.1f}% "
              f"{'faster' if change < 0 else 'slower'} per turn from one config value.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Aurora voice-turn latency benchmark")
    parser.add_argument("--provider", default=os.getenv("PROVIDER", "mock"))
    parser.add_argument("--endpoint-silence-ms", type=float,
                        default=float(os.getenv("ENDPOINT_SILENCE_MS", "600")))
    parser.add_argument("--simulate-network", dest="simulate", action="store_true",
                        default=None, help="add assumed STT/LLM/TTS round trips")
    parser.add_argument("--no-simulate-network", dest="simulate", action="store_false")
    parser.add_argument("--stt-ms", type=float, default=ASSUMED_STT_MS)
    parser.add_argument("--llm-ms", type=float, default=ASSUMED_LLM_CALL_MS)
    parser.add_argument("--tts-ms", type=float, default=ASSUMED_TTS_FIRST_AUDIO_MS)
    parser.add_argument("--tool-ms", type=float, default=ASSUMED_TOOL_CALL_MS)
    parser.add_argument("--label", default="run")
    parser.add_argument("--out", help="write the run to this JSON file")
    parser.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"),
                        help="compare two saved runs and exit")
    args = parser.parse_args()

    if args.compare:
        before, after = (json.loads(Path(path).read_text(encoding="utf-8"))
                         for path in args.compare)
        compare(before, after)
        return

    simulate = args.simulate if args.simulate is not None else args.provider == "mock"
    os.environ["PROVIDER"] = args.provider
    run = run_benchmark(
        provider_name=args.provider,
        endpoint_silence_ms=args.endpoint_silence_ms,
        simulate=simulate,
        stt_ms=args.stt_ms,
        llm_ms=args.llm_ms,
        tts_ms=args.tts_ms,
        tool_ms=args.tool_ms,
    )
    print_run(run, args.label.upper())
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(run, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
