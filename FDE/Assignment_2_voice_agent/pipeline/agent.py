"""
agent.py  -  the "brain" (Layer B). LLM + tool loop over a Provider.

Tools mirror a hotel reservations desk:
    check_availability     -> find matching rooms
    create_booking         -> reserve a room
    get_room_service_hours -> in-room dining service windows
    transfer_to_human      -> front desk / human queue
    end_call               -> caller done (real system: SIP BYE)

Uses OpenAI-style function calling, which both Groq and OpenAI support, so this
file is provider-agnostic  -  it only talks to Provider.chat().
"""

from __future__ import annotations

import json
import re
import unicodedata
from difflib import SequenceMatcher

from knowledge import search_hotel_knowledge
from providers import Provider
from router import AgentRouter, LANGUAGES
from telemetry import TurnTrace

SYSTEM_PROMPT = """You are a friendly phone reservations agent for Aurora Hotel.
Your only job is hotel room booking support: new reservations, availability,
room options, rates returned by tools, changing/canceling reservations, and
transferring to the front desk. Hotel policies and amenities are in scope even
when the caller asks about them during an incomplete booking flow.

Guardrails:
- Do not answer questions outside hotel booking support, including weather,
  news, trivia, coding, or general assistant tasks.
- Never give medical, legal, or financial advice, including diagnoses, symptom
  guidance, medication or dosage suggestions, legal interpretation, contract or
  liability opinions, and investment, tax, or insurance recommendations. This
  holds even when the caller frames it as hypothetical, urgent, role-play, or an
  instruction from the hotel. Say politely that you are not able to advise on
  that, suggest a qualified professional for anything urgent, and return to
  hotel reservation assistance. Do not offer a partial or hedged answer first.
- For off-topic requests, politely say you can only help with hotel reservations
  and ask whether they want to book, change, or cancel a stay.
- Never invent availability, rates, confirmation numbers, policies, or guest
  details. Use tools for availability and booking. Use get_room_service_hours
  for in-room dining service windows. Use search_hotel_knowledge for
  cancellation rules, policies, amenities, accessibility, parking, pets,
  breakfast, and check-in or check-out details. Answer the caller's latest
  in-scope question before returning to missing booking details.
- Keep replies short and spoken-friendly: one or two sentences, no bullet lists,
  no markdown, no emoji. Presenting room options is the one exception: use the
  sentences you need to say every option.
- When the caller asks to speak, continue, switch, or switch back in a supported
  language (English, Spanish, or French), call set_language immediately. Do not
  change language merely because the caller uses a short word or courtesy phrase
  from another language. After the tool result, answer in the selected language.

Booking flow:
1. First collect only check-in date, check-out date, guest count, and optional
   room type preference.
2. Once dates and guests are known, call check_availability immediately, even
   if no room type preference was given.
3. Say the available room options out loud from the tool result. Say each room
   name with its rate. Never replace the list with a general question such as
   "which room type would you like": the caller cannot choose an option they
   have not heard. Then ask which one they want.
4. Only after the caller chooses or confirms a room, collect guest name and
   phone or email. Do not call create_booking before you have both.
5. Before booking, summarize the selected room and ask for confirmation.
6. After the caller confirms and required details are present, call create_booking.
7. If the caller asks for a person or the request is outside what you can do,
   call transfer_to_human. When the conversation is clearly over, call end_call."""

# OpenAI-style tool schema (works on Groq too).
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "set_language",
            "description": "Set the response language for this call when the caller asks to speak, "
                           "continue, switch, or switch back in English, Spanish, or French. Only call "
                           "for an explicit language-change request, not an isolated foreign word or "
                           "courtesy.",
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["en", "es", "fr"],
                        "description": "Requested response language: en for English, es for Spanish, "
                                       "or fr for French.",
                    },
                },
                "required": ["language"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_availability",
            "description": "Check hotel room availability for dates, guests, and optional room type.",
            "parameters": {
                "type": "object",
                "properties": {
                    "check_in": {
                        "type": "string",
                        "description": "Check-in date as stated by the caller.",
                    },
                    "check_out": {
                        "type": "string",
                        "description": "Check-out date as stated by the caller.",
                    },
                    "guests": {
                        "type": ["integer", "string"],
                        "description": "Number of guests. Use a whole number, not words.",
                    },
                    "room_type": {
                        "type": "string",
                        "description": "Optional preference: standard, king, suite, family, or accessible.",
                    },
                },
                "required": ["check_in", "check_out", "guests"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_booking",
            "description": "Create a hotel booking after the caller confirms the room option.",
            "parameters": {
                "type": "object",
                "properties": {
                    "check_in": {"type": "string"},
                    "check_out": {"type": "string"},
                    "guests": {
                        "type": ["integer", "string"],
                        "description": "Number of guests. Use a whole number, not words.",
                    },
                    "room_type": {"type": "string"},
                    "guest_name": {"type": "string"},
                    "contact": {
                        "type": "string",
                        "description": "Phone number or email for the booking.",
                    },
                },
                "required": [
                    "check_in",
                    "check_out",
                    "guests",
                    "room_type",
                    "guest_name",
                    "contact",
                ],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_room_service_hours",
            "description": "Get in-room dining service windows for breakfast, lunch, or dinner. "
                           "Always use for room service or in-room dining hours. These are live "
                           "operational hours, not a published policy, so never state them from memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "meal": {
                        "type": "string",
                        "enum": ["breakfast", "lunch", "dinner", "all"],
                        "description": "Which service window the caller asked about. "
                                       "Use all when the caller did not name a meal.",
                    },
                },
                "required": ["meal"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_hotel_knowledge",
            "description": "Retrieve grounded Aurora Hotel policies, amenities, and operating details. "
                           "Always use for cancellation rules, check-in or check-out times, parking, "
                           "pets, breakfast, accessibility, and other hotel-information questions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The caller's policy or hotel-information question.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "transfer_to_human",
            "description": "Hand the call to a human agent queue. Use when the caller "
                           "asks for a person or the request is out of scope.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "end_call",
            "description": "End the call politely when the conversation is finished.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

_KNOWLEDGE_INTENT_PHRASES = (
    "cancellation policy", "cancelation policy", "cancellation fee", "cancel fee",
    "cancellation charge", "when can i cancel", "refundable", "non-refundable",
    "pet policy", "pets allowed", "dogs allowed", "bring my dog", "bring a pet",
    "parking", "valet", "breakfast", "check-in", "check in", "check-out",
    "check out", "accessibility", "accessible room", "wi-fi", "wifi", "amenities",
    "política de cancelación", "politica de cancelacion", "mascotas",
    "estacionamiento", "desayuno", "accesibilidad",
    "politique d'annulation", "politique d annulation", "animaux", "chien",
    "stationnement", "voiturier", "petit-déjeuner", "petit dejeuner",
    "accessibilité", "chambre accessible", "chambres accessibles",
)

# Room service hours are live operations, not a published policy, so this intent
# must win over the knowledge phrases above ("room service breakfast" contains
# "breakfast"). Ordering in required_tool_for() enforces that.
_ROOM_SERVICE_PHRASES = (
    "room service", "in-room dining", "in room dining", "room-service",
    "servicio a la habitación", "servicio a la habitacion", "servicio de habitación",
    "servicio de habitacion", "service en chambre", "service à la chambre",
    "service a la chambre", "service d'étage", "service d etage",
)

_MEAL_TERMS = {
    "breakfast": ("breakfast", "desayuno", "petit-déjeuner", "petit dejeuner", "dejeuner matin"),
    "lunch": ("lunch", "almuerzo", "comida", "déjeuner", "dejeuner"),
    "dinner": ("dinner", "cena", "dîner", "diner", "supper"),
}

_FUZZY_AMENITY_TERMS = (
    "mascota", "mascotas", "pet", "pets", "parking", "estacionamiento",
    "breakfast", "desayuno", "accessibility", "accesibilidad", "wifi",
    "animaux", "stationnement", "accessibilite",
)

_LANGUAGE_NAMES = {
    "en": {"english", "ingles", "anglais"},
    "es": {"spanish", "espanol", "espagnol"},
    "fr": {"french", "frances", "francais"},
}

# Medical, legal, and financial advice is refused in application code rather than
# by the system prompt alone. A prompt is a request to a probabilistic model; this
# is a decision. Terms are deliberately high-precision: a caller asking whether the
# rate includes tax must still reach retrieval, so "tax advice" is listed and bare
# "tax" is not.
_RESTRICTED_ADVICE_TERMS = (
    # medical
    "medical advice", "diagnose", "diagnosis", "symptom", "medication",
    "dosage", "dose of", "ibuprofen", "aspirin", "antibiotic", "prescription",
    "chest hurts", "chest pain", "allergic reaction", "blood pressure",
    "what should i take", "should i take",
    "consejo medico", "medicamento", "dosis", "sintomas",
    "conseil medical", "medicament", "posologie", "mal a la tete",
    # legal
    "legal advice", "lawsuit", "sue the hotel", "sue you", "am i liable",
    "liability", "legally binding", "is it legal", "my legal rights",
    "consejo legal", "demandar al hotel", "responsabilidad legal",
    "conseil juridique", "poursuivre en justice", "responsabilite legale",
    # financial
    "financial advice", "investment advice", "should i invest", "invest in",
    "tax advice", "mortgage", "crypto", "bitcoin", "retirement account",
    "consejo financiero", "deberia invertir", "conseil financier",
    "devrais-je investir",
)

_RESTRICTED_ADVICE_REPLY = {
    "en": "I'm sorry, I'm not able to give medical, legal, or financial advice. "
          "Please speak with a qualified professional about that, and call emergency "
          "services if it is urgent. I can help with hotel reservations if you would "
          "like to book, change, or cancel a stay.",
    "es": "Lo siento, no puedo dar consejos médicos, legales ni financieros. "
          "Consulte a un profesional calificado sobre eso y llame a los servicios de "
          "emergencia si es urgente. Puedo ayudarle con reservas de hotel si desea "
          "reservar, cambiar o cancelar una estancia.",
    "fr": "Je suis désolé, je ne peux pas donner de conseils médicaux, juridiques ou "
          "financiers. Veuillez consulter un professionnel qualifié à ce sujet et "
          "appeler les services d'urgence si c'est urgent. Je peux vous aider avec les "
          "réservations de l'hôtel si vous souhaitez réserver, modifier ou annuler un séjour.",
}


def _normalized_text(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    stripped = "".join(
        character for character in decomposed if not unicodedata.combining(character)
    )
    return " ".join(stripped.split())


def restricted_advice_request(text: str) -> bool:
    """True when the caller is asking for medical, legal, or financial advice."""
    normalized = _normalized_text(text)
    return any(term in normalized for term in _RESTRICTED_ADVICE_TERMS)


def _normalized_tokens(text: str) -> list[str]:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    normalized = "".join(
        character for character in decomposed
        if not unicodedata.combining(character)
    )
    return re.findall(r"[a-z0-9]+", normalized)


def _has_fuzzy_term(tokens: list[str], terms: tuple[str, ...], cutoff: float = 0.82) -> bool:
    return any(
        SequenceMatcher(None, token, term).ratio() >= cutoff
        for token in tokens
        for term in terms
    )


def explicit_language_request(text: str, language: str) -> bool:
    """Require the target language name before allowing a session-state change."""
    return bool(set(_normalized_tokens(text)) & _LANGUAGE_NAMES.get(language, set()))


def requested_meal(text: str) -> str:
    """Pick the service window the caller named, or 'all' when they named none."""
    normalized = " ".join(text.lower().split())
    for meal, terms in _MEAL_TERMS.items():
        if any(term in normalized for term in terms):
            return meal
    return "all"


def required_tool_for(text: str) -> str | None:
    """Route high-confidence knowledge intents before probabilistic LLM selection."""
    normalized = " ".join(text.lower().split())
    if any(phrase in normalized for phrase in _ROOM_SERVICE_PHRASES):
        return "get_room_service_hours"
    if any(phrase in normalized for phrase in _KNOWLEDGE_INTENT_PHRASES):
        return "search_hotel_knowledge"
    tokens = _normalized_tokens(text)
    if _has_fuzzy_term(tokens, _FUZZY_AMENITY_TERMS):
        return "search_hotel_knowledge"
    has_policy = _has_fuzzy_term(tokens, ("policy", "politica"))
    has_cancellation = _has_fuzzy_term(tokens, ("cancellation", "cancelacion"))
    if has_policy and has_cancellation:
        return "search_hotel_knowledge"
    return None


def _named_tool_choice(name: str) -> dict:
    return {"type": "function", "function": {"name": name}}


# --- Mock tool implementations (swap for real backends in production) ---

_ROOMS = {
    "standard": {"name": "Standard Queen", "rate": "$189/night", "capacity": 2},
    "king": {"name": "Deluxe King", "rate": "$229/night", "capacity": 2},
    "suite": {"name": "Harbor Suite", "rate": "$329/night", "capacity": 4},
    "family": {"name": "Family Double Queen", "rate": "$269/night", "capacity": 5},
    "accessible": {"name": "Accessible Queen", "rate": "$199/night", "capacity": 2},
}


# In-room dining windows. A real deployment reads these from the property
# management system so a kitchen closure changes the answer without a redeploy.
# Stored as (start, end) so each language can join them with its own connector.
_ROOM_SERVICE_HOURS = {
    "breakfast": ("6:30 AM", "11:00 AM"),
    "lunch": ("11:30 AM", "2:30 PM"),
    "dinner": ("5:00 PM", "11:00 PM"),
}

# Caller-facing tool results are framed in the session language. Room names,
# rates, dates, confirmation IDs, and contact details are proper nouns and stay
# unchanged, per the system prompt. Only the sentence around them is translated,
# which is why the tool needs the language but not a translation model.
_TIME_CONNECTOR = {"en": " to ", "es": " a ", "fr": " à "}

_MEAL_DISPLAY = {
    "en": {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner"},
    "es": {"breakfast": "el desayuno", "lunch": "el almuerzo", "dinner": "la cena"},
    "fr": {"breakfast": "le petit-déjeuner", "lunch": "le déjeuner", "dinner": "le dîner"},
}

_ROOM_SERVICE_FRAME = {
    "en": {"one": "Room service {meal} is served {hours}.",
           "all": "Room service hours: {windows}."},
    "es": {"one": "El servicio a la habitación sirve {meal} de {hours}.",
           "all": "Horarios del servicio a la habitación: {windows}."},
    "fr": {"one": "Le service en chambre sert {meal} de {hours}.",
           "all": "Horaires du service en chambre : {windows}."},
}

# Tool results carry DATA ONLY. Never put a caller-facing question here: a real
# model reads a tool result as material to relay, so a question inside it reads
# as "already asked" and the model answers with a bare acknowledgement instead of
# reading out the rooms. The follow-up question belongs to the phrasing layer.
_AVAILABILITY_FRAME = {
    "en": {"list": "Available rooms for {check_in} to {check_out}: {rooms}.",
           "none": "No matching rooms are available for that guest count."},
    "es": {"list": "Habitaciones disponibles del {check_in} al {check_out}: {rooms}.",
           "none": "No hay habitaciones disponibles para ese número de huéspedes."},
    "fr": {"list": "Chambres disponibles du {check_in} au {check_out} : {rooms}.",
           "none": "Aucune chambre ne correspond à ce nombre de personnes."},
}

_BOOKING_FRAME = {
    "en": "Booking confirmed. Confirmation {code} for {name} in a {room} from "
          "{check_in} to {check_out} for {guests} guest(s). Confirmation sent to {contact}.",
    "es": "Reserva confirmada. Confirmación {code} para {name} en {room} del "
          "{check_in} al {check_out} para {guests} huésped(es). Se envió la confirmación a {contact}.",
    "fr": "Réservation confirmée. Confirmation {code} pour {name} dans {room} du "
          "{check_in} au {check_out} pour {guests} personne(s). Confirmation envoyée à {contact}.",
}

_TRANSFER_RESULT = {
    "en": "Transferring you to the front desk.",
    "es": "Le transfiero a la recepción.",
    "fr": "Je vous transfère à la réception.",
}

_END_RESULT = {
    "en": "Ending the call.",
    "es": "Gracias por llamar a Aurora Hotel. Adiós.",
    "fr": "Merci d'avoir appelé l'Aurora Hotel. Au revoir.",
}


def _hours_text(meal: str, language: str) -> str:
    start, end = _ROOM_SERVICE_HOURS[meal]
    return f"{start}{_TIME_CONNECTOR[language]}{end}"


def _lang(language: str) -> str:
    return language if language in LANGUAGES else "en"


def _normalize_room_type(value: str | None) -> str | None:
    room_type = (value or "").strip().lower()
    if not room_type:
        return None
    for key in _ROOMS:
        if key in room_type:
            return key
    if "double" in room_type:
        return "family"
    if "queen" in room_type:
        return "standard"
    return None


def run_tool(name: str, args: dict, language: str = "en") -> dict:
    """Execute a tool call, framing the caller-facing result in `language`.

    Business tools return caller-ready text so the phrasing layer (the model, or
    the mock) can speak it verbatim without re-translating. Proper nouns - room
    names, rates, dates, confirmation IDs, contact details - are never translated.
    The optional 'action' key is a control signal for the voice loop
    ('transfer' -> SIP REFER, 'hangup' -> SIP BYE)."""
    language = _lang(language)
    if name == "check_availability":
        guests = int(args.get("guests") or 1)
        preferred = _normalize_room_type(args.get("room_type"))
        rooms = []
        for key, room in _ROOMS.items():
            if preferred and key != preferred:
                continue
            if guests <= room["capacity"]:
                rooms.append(f"{room['name']} at {room['rate']}")
        if not rooms:
            return {"result": _AVAILABILITY_FRAME[language]["none"]}
        return {
            "result": _AVAILABILITY_FRAME[language]["list"].format(
                check_in=args.get("check_in"),
                check_out=args.get("check_out"),
                rooms="; ".join(rooms),
            ),
        }
    if name == "create_booking":
        # Refuse an incomplete booking instead of confirming one for "None".
        # A model under a "be brief" instruction will sometimes call this tool
        # before it has collected the guest details, and a confirmation the
        # caller can quote back is far worse than an extra question.
        missing = [
            field for field in
            ("check_in", "check_out", "guests", "room_type", "guest_name", "contact")
            if not str(args.get(field) or "").strip()
        ]
        if missing:
            return {
                "result": "Booking not created. Required details are missing: "
                          f"{', '.join(missing)}. Ask the caller for them, then "
                          "call create_booking again.",
            }
        room_key = _normalize_room_type(args.get("room_type")) or "standard"
        room = _ROOMS[room_key]
        return {
            "result": _BOOKING_FRAME[language].format(
                code="AH-4827",
                name=args.get("guest_name"),
                room=room["name"],
                check_in=args.get("check_in"),
                check_out=args.get("check_out"),
                guests=args.get("guests"),
                contact=args.get("contact"),
            ),
        }
    if name == "get_room_service_hours":
        meal = str(args.get("meal", "all")).strip().lower()
        frame = _ROOM_SERVICE_FRAME[language]
        if meal in _ROOM_SERVICE_HOURS:
            return {
                "result": frame["one"].format(
                    meal=_MEAL_DISPLAY[language][meal],
                    hours=_hours_text(meal, language),
                ),
                "sources": [f"room_service_schedule#{meal}"],
            }
        windows = ", ".join(
            f"{_MEAL_DISPLAY[language][meal]} {_hours_text(meal, language)}"
            for meal in _ROOM_SERVICE_HOURS
        )
        return {
            "result": frame["all"].format(windows=windows),
            "sources": ["room_service_schedule#all"],
        }
    if name == "search_hotel_knowledge":
        return search_hotel_knowledge(str(args.get("query", "")))
    if name == "transfer_to_human":
        return {"result": _TRANSFER_RESULT[language], "action": "transfer"}
    if name == "end_call":
        return {"result": _END_RESULT[language], "action": "hangup"}
    return {"result": f"Unknown tool: {name}"}


class Agent:
    """LLM + tool loop for one call. Holds conversation history."""

    def __init__(self, provider: Provider):
        self.provider = provider
        self.messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        self.router = AgentRouter()
        self.current_language = "en"
        self.current_locale = LANGUAGES["en"]["locale"]
        self.last_trace: TurnTrace | None = None
        self.last_sources: list[str] = []

    def respond(self, user_text: str, trace: TurnTrace | None = None) -> tuple[str, str | None]:
        """Take the caller's transcript, return (spoken_reply, action|None).

        Loops until the model produces a plain text reply, executing any tool
        calls in between. `action` is the last control signal seen (transfer/
        hangup), which the voice loop uses to end the call.
        """
        trace = trace or TurnTrace()
        self.last_trace = trace
        self.last_sources = []

        with trace.span("routing"):
            route = self.router.route()
            self.current_language = route.language
            self.current_locale = route.locale
            self.messages[0]["content"] = f"{SYSTEM_PROMPT}\n\n{self.router.instruction()}"
        trace.event(
            "router.selected",
            language=route.language,
            locale=route.locale,
            changed=route.changed,
            reason=route.reason,
        )
        trace.attributes.update({
            "language": route.language,
            "locale": route.locale,
            "provider": getattr(self.provider, "name", "unknown"),
            "model": getattr(self.provider, "llm_model", "unknown"),
        })
        trace.event("caller.transcript", text=user_text)
        self.messages.append({"role": "user", "content": user_text})
        action: str | None = None

        # Deterministic guardrail. Refusing here rather than in the prompt means
        # the caller cannot reach the model at all, so no jailbreak, retrieval
        # route, or tool call can produce advice. It also costs no tokens and no
        # model latency, which matters inside an 800 ms voice turn budget.
        if restricted_advice_request(user_text):
            reply = _RESTRICTED_ADVICE_REPLY[self.current_language]
            trace.event("guardrail.restricted_advice", enforcedBy="application")
            self.messages.append({"role": "assistant", "content": reply})
            trace.event("assistant.response", text=reply, action=None)
            return reply, None

        required_tool = required_tool_for(user_text)
        if required_tool:
            trace.event(
                "tool.route_selected",
                tool=required_tool,
                reason="hotel_knowledge_intent",
            )
        first_model_call = True

        while True:
            with trace.span("llm", model=getattr(self.provider, "llm_model", "unknown")):
                tool_choice = (
                    _named_tool_choice(required_tool)
                    if first_model_call and required_tool
                    else None
                )
                resp = self.provider.chat(
                    self.messages,
                    tools=TOOLS,
                    tool_choice=tool_choice,
                )
                first_model_call = False
            msg = resp.choices[0].message

            if not msg.tool_calls:
                reply = msg.content or ""
                self.messages.append({"role": "assistant", "content": reply})
                trace.event("assistant.response", text=reply, action=action)
                return reply, action

            # Record the assistant's tool-call turn, then answer each call.
            self.messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {"name": tc.function.name,
                                     "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ],
            })
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                trace.event("tool.requested", tool=tc.function.name, arguments=args)
                with trace.span("tools", tool=tc.function.name):
                    if tc.function.name == "set_language":
                        language = str(args.get("language", "")).lower()
                        try:
                            if not explicit_language_request(user_text, language):
                                trace.event(
                                    "router.language_change_rejected",
                                    requestedLanguage=language,
                                    reason="no_explicit_language_name",
                                )
                                raise PermissionError
                            language_route = self.router.set_language(language)
                            self.current_language = language_route.language
                            self.current_locale = language_route.locale
                            self.messages[0]["content"] = (
                                f"{SYSTEM_PROMPT}\n\n{self.router.instruction()}"
                            )
                            trace.attributes.update({
                                "language": language_route.language,
                                "locale": language_route.locale,
                            })
                            trace.event(
                                "router.language_changed",
                                language=language_route.language,
                                locale=language_route.locale,
                                changed=language_route.changed,
                                reason=language_route.reason,
                            )
                            result = {
                                "result": (
                                    "Response language set to "
                                    f"{LANGUAGES[language_route.language]['name']}."
                                ),
                            }
                        except PermissionError:
                            result = {
                                "result": (
                                    "Language unchanged because the caller did not explicitly "
                                    "request the target language. Continue in the current language."
                                ),
                            }
                        except ValueError:
                            result = {
                                "result": "Unsupported language. Continue in the current language.",
                            }
                    elif tc.function.name == "search_hotel_knowledge":
                        with trace.span("retrieval", query=args.get("query", "")):
                            result = run_tool(tc.function.name, args, self.current_language)
                    else:
                        result = run_tool(tc.function.name, args, self.current_language)
                trace.event(
                    "tool.result",
                    tool=tc.function.name,
                    result=result.get("result", ""),
                    sources=result.get("sources", []),
                    action=result.get("action"),
                )
                self.last_sources.extend(result.get("sources", []))
                if result.get("action"):
                    action = result["action"]
                self.messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result["result"],
                })
            # loop again so the model can speak given the tool results
