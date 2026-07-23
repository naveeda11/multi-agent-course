"""Focused offline tests for routing, grounding, telemetry, and capacity."""

from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ["PROVIDER"] = "mock"
os.environ.setdefault("TTS_BACKEND", "print")

from agent import (
    Agent,
    TOOLS,
    explicit_language_request,
    required_tool_for,
    requested_meal,
    restricted_advice_request,
    run_tool,
)
from knowledge import search_hotel_knowledge
from latency_bench import compare, run_benchmark
from providers import MockProvider, _env_or_default, _mk_tool, make_provider
from router import LANGUAGES, AgentRouter
from scale_check import estimate_capacity
from telemetry import TurnTrace, format_trace


class RouterTests(unittest.TestCase):
    def test_tool_selected_language_persists(self):
        router = AgentRouter()
        self.assertEqual(router.set_language("es").language, "es")
        self.assertEqual(router.route().language, "es")
        self.assertEqual(router.set_language("en").language, "en")

    def test_language_switch_intent_uses_control_tool(self):
        agent = Agent(make_provider("mock"))
        spanish_trace = TurnTrace(session_id="test", turn_id="spanish")
        agent.respond("Can you please speak in Spanish?", trace=spanish_trace)
        english_trace = TurnTrace(session_id="test", turn_id="english")
        reply, _ = agent.respond("Let me switch back to English.", trace=english_trace)

        self.assertEqual(agent.current_language, "en")
        self.assertIn("continue in English", reply)
        requested = [
            event["attributes"].get("tool")
            for event in english_trace.events
            if event["name"] == "tool.requested"
        ]
        self.assertEqual(requested, ["set_language"])
        self.assertIn(
            "router.language_changed",
            [event["name"] for event in english_trace.events],
        )

    def test_language_change_requires_explicit_target_name(self):
        self.assertTrue(explicit_language_request("Switch back to English", "en"))
        self.assertTrue(explicit_language_request("Por favor, habla español", "es"))
        self.assertFalse(explicit_language_request("¡Gracias!", "es"))

    def test_overeager_language_tool_cannot_change_state(self):
        class OvereagerProvider(MockProvider):
            def chat(self, messages, tools=None, tool_choice=None):
                if messages[-1].get("role") == "user":
                    return _mk_tool("set_language", {"language": "es"})
                return super().chat(messages, tools=tools, tool_choice=tool_choice)

        agent = Agent(OvereagerProvider())
        trace = TurnTrace(session_id="test", turn_id="courtesy")
        agent.respond("¡Gracias!", trace=trace)

        self.assertEqual(agent.current_language, "en")
        self.assertIn(
            "router.language_change_rejected",
            [event["name"] for event in trace.events],
        )


class FrenchRoutingTests(unittest.TestCase):
    def test_french_maps_to_fr_fr_locale(self):
        router = AgentRouter()
        route = router.set_language("fr")
        self.assertEqual((route.language, route.locale), ("fr", "fr-FR"))
        self.assertEqual(LANGUAGES["fr"]["locale"], "fr-FR")

    def test_french_requires_an_explicit_request(self):
        self.assertTrue(explicit_language_request("Can you speak French please?", "fr"))
        self.assertTrue(explicit_language_request("Parlez français", "fr"))
        self.assertFalse(explicit_language_request("Merci beaucoup!", "fr"))
        self.assertFalse(explicit_language_request("Bonjour", "fr"))

    def test_french_session_persists_then_reverts(self):
        agent = Agent(make_provider("mock"))
        agent.respond("Can you speak French please?", trace=TurnTrace())
        self.assertEqual(agent.current_locale, "fr-FR")
        agent.respond("Merci !", trace=TurnTrace())
        self.assertEqual(agent.current_language, "fr")  # courtesy does not revert
        agent.respond("Switch back to English.", trace=TurnTrace())
        self.assertEqual(agent.current_locale, "en-US")

    def test_french_policy_query_reaches_the_right_source(self):
        self.assertEqual(
            search_hotel_knowledge("Quelle est la politique d'annulation ?")["sources"],
            ["hotel_policies.md#Cancellation"],
        )
        self.assertEqual(
            search_hotel_knowledge("Combien coûte le stationnement ?")["sources"],
            ["hotel_policies.md#Parking"],
        )
        self.assertEqual(
            search_hotel_knowledge("Avez-vous des chambres accessibles ?")["sources"][0],
            "hotel_policies.md#Accessibility",
        )


class RoomServiceTests(unittest.TestCase):
    def test_room_service_intent_outranks_the_breakfast_keyword(self):
        self.assertEqual(
            required_tool_for("What time does room service start breakfast?"),
            "get_room_service_hours",
        )
        self.assertEqual(
            required_tool_for("Is breakfast included in the rate?"),
            "search_hotel_knowledge",
        )

    def test_named_meal_returns_only_that_window(self):
        result = run_tool("get_room_service_hours", {"meal": "dinner"})
        self.assertIn("5:00 PM to 11:00 PM", result["result"])
        self.assertNotIn("6:30 AM", result["result"])
        self.assertEqual(result["sources"], ["room_service_schedule#dinner"])

    def test_unnamed_meal_returns_every_window(self):
        result = run_tool("get_room_service_hours", {"meal": "all"})
        for window in ("6:30 AM to 11:00 AM", "11:30 AM to 2:30 PM", "5:00 PM to 11:00 PM"):
            self.assertIn(window, result["result"])

    def test_meal_is_extracted_across_languages(self):
        self.assertEqual(requested_meal("room service dinner"), "dinner")
        self.assertEqual(requested_meal("servicio a la habitación, la cena"), "dinner")
        self.assertEqual(requested_meal("service en chambre"), "all")

    def test_hours_are_never_answered_from_the_policy_file(self):
        # Sparse retrieval answers "room service hours" with policy sections that
        # contain no service windows at all, because those chunks share the word
        # "room". Routing to the tool is what keeps that confident-but-wrong
        # passage out of the caller's answer.
        mis_retrieved = search_hotel_knowledge("room service hours")["sources"]
        self.assertTrue(mis_retrieved)
        self.assertTrue(
            all(source.startswith("hotel_policies.md#") for source in mis_retrieved),
            mis_retrieved,
        )
        self.assertEqual(required_tool_for("room service hours"), "get_room_service_hours")


class BookingValidationTests(unittest.TestCase):
    COMPLETE = {
        "check_in": "August 12", "check_out": "August 14", "guests": 2,
        "room_type": "king", "guest_name": "Naveed", "contact": "naveed@example.com",
    }

    def test_complete_booking_is_confirmed(self):
        result = run_tool("create_booking", dict(self.COMPLETE))
        self.assertIn("AH-4827", result["result"])
        self.assertIn("Naveed", result["result"])

    def test_missing_guest_details_do_not_confirm_a_booking(self):
        for field in ("guest_name", "contact", "check_in", "room_type"):
            args = dict(self.COMPLETE)
            args.pop(field)
            result = run_tool("create_booking", args)
            self.assertNotIn("AH-4827", result["result"], field)
            self.assertIn("Booking not created", result["result"], field)
            self.assertIn(field, result["result"], field)

    def test_blank_guest_name_is_treated_as_missing(self):
        args = dict(self.COMPLETE, guest_name="   ")
        result = run_tool("create_booking", args)
        self.assertNotIn("AH-4827", result["result"])
        self.assertNotIn("None", result["result"])


class AvailabilityResultTests(unittest.TestCase):
    def test_guest_count_schema_accepts_provider_numeric_strings(self):
        guest_schemas = [
            tool["function"]["parameters"]["properties"]["guests"]
            for tool in TOOLS
            if tool["function"]["name"] in {"check_availability", "create_booking"}
        ]
        self.assertEqual(len(guest_schemas), 2)
        for schema in guest_schemas:
            self.assertEqual(schema["type"], ["integer", "string"])

        result = run_tool("check_availability", {
            "check_in": "August 12", "check_out": "August 14", "guests": "2",
        })
        self.assertIn("Standard Queen", result["result"])

    def test_tool_result_carries_no_caller_question(self):
        # A question inside a tool result reads to a live model as "already
        # asked", so it acknowledges instead of reading out the rooms.
        for language in ("en", "es", "fr"):
            result = run_tool("check_availability", {
                "check_in": "August 12", "check_out": "August 14", "guests": 2,
            }, language)["result"]
            self.assertNotIn("?", result, language)
            self.assertIn("$", result, language)

    def test_mock_adds_the_follow_up_question(self):
        agent = Agent(make_provider("mock"))
        reply, _ = agent.respond(
            "I need a room from August 12 to August 14 for two guests.",
            trace=TurnTrace(),
        )
        self.assertIn("Standard Queen", reply)
        self.assertIn("?", reply)

    def test_mock_preserves_selected_room_and_caller_details(self):
        agent = Agent(make_provider("mock"))
        agent.respond(
            "I need a room from August 12 to August 14 for two guests.",
            trace=TurnTrace(),
        )
        selection, _ = agent.respond("The Deluxe King, please.", trace=TurnTrace())
        summary, _ = agent.respond(
            "Yes, book it for Naveed at naveed@example.com.",
            trace=TurnTrace(),
        )
        reply, _ = agent.respond("Yes, I confirm.", trace=TurnTrace())

        self.assertIn("Deluxe King", selection)
        self.assertIn("Naveed", summary)
        self.assertNotIn("AH-4827", summary)
        self.assertIn("Deluxe King", reply)
        self.assertIn("Naveed", reply)
        self.assertIn("naveed@example.com", reply)
        self.assertNotIn("Priya", reply)

    def test_mock_preserves_french_dates_through_confirmation(self):
        agent = Agent(make_provider("mock"))
        agent.respond("Parlez français.", trace=TurnTrace())
        availability, _ = agent.respond(
            "J'ai besoin d'une chambre du 12 août au 14 août pour deux personnes.",
            trace=TurnTrace(),
        )
        agent.respond("La chambre Deluxe King, s'il vous plaît.", trace=TurnTrace())
        summary, _ = agent.respond(
            "Oui, réservez-la pour Naveed, naveed@example.com.",
            trace=TurnTrace(),
        )
        reply, _ = agent.respond("Oui, je confirme.", trace=TurnTrace())

        self.assertIn("12 août", availability)
        self.assertIn("12 août", summary)
        self.assertIn("12 août", reply)
        self.assertIn("Naveed", reply)


class RestrictedAdviceTests(unittest.TestCase):
    def test_advice_requests_are_detected(self):
        for text in (
            "What medication should I take?",
            "Am I liable if I cancel late?",
            "Should I invest in stocks to pay for the room?",
            "Quel medicament dois-je prendre ?",
            "Necesito consejo medico",
        ):
            self.assertTrue(restricted_advice_request(text), text)

    def test_ordinary_hotel_questions_are_not_blocked(self):
        for text in (
            "Does the rate include tax?",
            "Can I cancel my reservation?",
            "What is the cancellation policy?",
            "Is breakfast included in the rate?",
            "Can I get a receipt for my expense report?",
        ):
            self.assertFalse(restricted_advice_request(text), text)

    def test_guardrail_refuses_without_calling_the_model(self):
        class CountingProvider(MockProvider):
            def __init__(self):
                super().__init__()
                self.calls = 0

            def chat(self, messages, tools=None, tool_choice=None):
                self.calls += 1
                return super().chat(messages, tools=tools, tool_choice=tool_choice)

        provider = CountingProvider()
        agent = Agent(provider)
        trace = TurnTrace(session_id="test", turn_id="advice")
        reply, action = agent.respond(
            "My chest hurts. What medication should I take before check-in?", trace=trace
        )

        self.assertEqual(provider.calls, 0)
        self.assertIsNone(action)
        self.assertIn("not able to give medical", reply)
        self.assertIn("hotel reservations", reply)
        self.assertIn("guardrail.restricted_advice", [e["name"] for e in trace.events])

    def test_policy_keyword_cannot_smuggle_an_advice_request_into_retrieval(self):
        agent = Agent(make_provider("mock"))
        trace = TurnTrace(session_id="test", turn_id="smuggle")
        agent.respond("What medication should I take before check-in?", trace=trace)
        requested = [
            event["attributes"].get("tool")
            for event in trace.events
            if event["name"] == "tool.requested"
        ]
        self.assertEqual(requested, [])

    def test_guardrail_answers_in_the_session_language(self):
        agent = Agent(make_provider("mock"))
        agent.respond("Can you speak French please?", trace=TurnTrace())
        reply, _ = agent.respond("Quel medicament dois-je prendre ?", trace=TurnTrace())
        self.assertIn("professionnel qualifi", reply)


class ProviderConfigurationTests(unittest.TestCase):
    def test_blank_model_override_uses_provider_default(self):
        with patch.dict(os.environ, {"LLM_MODEL": ""}):
            self.assertEqual(_env_or_default("LLM_MODEL", "gpt-4o-mini"), "gpt-4o-mini")

    def test_comment_only_model_override_uses_provider_default(self):
        with patch.dict(os.environ, {"LLM_MODEL": "# example model"}):
            self.assertEqual(_env_or_default("LLM_MODEL", "gpt-4o-mini"), "gpt-4o-mini")

    def test_explicit_model_override_is_preserved(self):
        with patch.dict(os.environ, {"LLM_MODEL": "gpt-4.1-mini"}):
            self.assertEqual(_env_or_default("LLM_MODEL", "gpt-4o-mini"), "gpt-4.1-mini")


class RetrievalTests(unittest.TestCase):
    def test_english_policy_returns_precise_source(self):
        result = search_hotel_knowledge("What is the cancellation policy?")
        self.assertEqual(result["sources"], ["hotel_policies.md#Cancellation"])

    def test_spanish_query_expands_to_english_knowledge(self):
        result = search_hotel_knowledge("¿Cuál es la política de mascotas?")
        self.assertEqual(result["sources"], ["hotel_policies.md#Pets"])

    def test_policy_intent_requires_grounding_tool(self):
        self.assertEqual(
            required_tool_for("What does the cancellation policy look like?"),
            "search_hotel_knowledge",
        )

    def test_cancellation_action_is_not_misrouted_to_rag(self):
        self.assertIsNone(required_tool_for("Please cancel my reservation"))

    def test_noisy_spanish_pet_policy_transcript_routes_to_rag(self):
        self.assertEqual(
            required_tool_for("Fiol es la politista di maskotas."),
            "search_hotel_knowledge",
        )

    def test_forced_tool_choice_is_sent_on_first_model_call(self):
        class RecordingProvider(MockProvider):
            def __init__(self):
                super().__init__()
                self.tool_choices = []

            def chat(self, messages, tools=None, tool_choice=None):
                self.tool_choices.append(tool_choice)
                return super().chat(messages, tools=tools, tool_choice=tool_choice)

        provider = RecordingProvider()
        agent = Agent(provider)
        trace = TurnTrace(session_id="test", turn_id="forced-rag")
        reply, _ = agent.respond("What is the cancellation policy?", trace=trace)

        self.assertIn("6:00 PM", reply)
        self.assertEqual(
            provider.tool_choices[0],
            {"type": "function", "function": {"name": "search_hotel_knowledge"}},
        )
        self.assertIsNone(provider.tool_choices[1])
        self.assertIn("tool.route_selected", [event["name"] for event in trace.events])


class TelemetryTests(unittest.TestCase):
    def test_tool_and_language_events_are_visible(self):
        agent = Agent(make_provider("mock"))
        trace = TurnTrace(session_id="test", turn_id="policy")
        reply, action = agent.respond("What is the pet policy?", trace=trace)
        payload = trace.finish(action=action, sources=agent.last_sources)
        event_names = [event["name"] for event in payload["events"]]
        requested_tools = [
            event["attributes"].get("tool")
            for event in payload["events"]
            if event["name"] == "tool.requested"
        ]
        self.assertIn("two dogs", reply)
        self.assertIn("retrieval.completed", event_names)
        self.assertEqual(requested_tools, ["search_hotel_knowledge"])
        self.assertEqual(payload["attributes"]["language"], "en")
        rendered = format_trace(payload)
        self.assertIn("tools        search_hotel_knowledge", rendered)
        self.assertIn("sources      hotel_policies.md#Pets", rendered)

    def test_sensitive_tool_arguments_are_redacted(self):
        trace = TurnTrace(session_id="test", turn_id="redaction")
        trace.event("tool.requested", arguments={
            "guest_name": "Priya Shah",
            "contact": "priya@example.com",
            "check_in": "August 12",
        })
        attributes = trace.events[0]["attributes"]["arguments"]
        self.assertEqual(attributes["guest_name"], "[REDACTED]")
        self.assertEqual(attributes["contact"], "[REDACTED]")
        self.assertEqual(attributes["check_in"], "August 12")


class LatencyBenchTests(unittest.TestCase):
    def _run(self, endpoint_silence_ms: float = 600.0) -> dict:
        return run_benchmark(
            provider_name="mock",
            endpoint_silence_ms=endpoint_silence_ms,
            simulate=True,
            stt_ms=220.0,
            llm_ms=480.0,
            tts_ms=300.0,
            tool_ms=40.0,
        )

    def test_five_turns_are_measured(self):
        run = self._run()
        self.assertEqual(len(run["turns"]), 5)
        self.assertEqual(run["summary"]["turns"], 5)
        for turn in run["turns"]:
            for stage in ("stt", "llm", "tts", "endpoint"):
                self.assertIn(stage, turn["stages"])

    def test_retrieval_is_not_billed_twice(self):
        # retrieval runs inside the tools span, so the total must exclude it.
        run = self._run()
        for turn in run["turns"]:
            stages = turn["stages"]
            expected = sum(stages.values()) - stages["retrieval"]
            self.assertAlmostEqual(turn["totalMs"], round(expected, 1), places=1)

    def test_blocked_advice_turn_skips_the_model_entirely(self):
        run = self._run()
        blocked = next(t for t in run["turns"] if "blocked advice" in t["label"])
        self.assertEqual(blocked["llmCalls"], 0)
        self.assertEqual(blocked["stages"]["llm"], 0.0)
        self.assertLess(blocked["totalMs"], run["summary"]["meanTotalMs"])

    def test_endpoint_silence_moves_only_the_endpoint_stage(self):
        # The locally-measured stages jitter by tenths of a millisecond between
        # runs, so compare with a tolerance. A 1 ms window still proves the
        # claim: a 250 ms endpoint change moves nothing else.
        before = self._run(600.0)
        after = self._run(350.0)
        self.assertAlmostEqual(
            after["summary"]["meanTotalMs"],
            before["summary"]["meanTotalMs"] - 250,
            delta=1.0,
        )
        for stage in ("stt", "llm", "tools", "tts"):
            self.assertAlmostEqual(
                after["summary"]["stageMeanMs"][stage],
                before["summary"]["stageMeanMs"][stage],
                delta=1.0,
                msg=stage,
            )

    def test_measured_and_simulated_runs_cannot_be_compared(self):
        measured = dict(self._run(), mode="measured")
        simulated = self._run()
        with self.assertRaises(SystemExit):
            compare(measured, simulated)


class ScaleTests(unittest.TestCase):
    def test_one_million_dau_example(self):
        result = estimate_capacity(
            dau=1_000_000,
            calls_per_dau=0.25,
            duration_minutes=4,
            turns_per_minute=3,
            peak_factor=8,
            sessions_per_worker=40,
            headroom=0.30,
            cost_per_minute=0,
        )
        self.assertAlmostEqual(result["peakConcurrency"], 5555.6)
        self.assertEqual(result["workers"], 181)


if __name__ == "__main__":
    unittest.main()
