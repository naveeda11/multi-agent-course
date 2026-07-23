"""
providers.py  -  one adaptor, two backends: Groq and OpenAI.

Groq speaks the OpenAI API dialect, so a single code path covers both  -  only
base_url, api_key, and model names differ. Switch with PROVIDER=groq|openai in
.env; move to your OpenAI key later by flipping that one value.

Exposes three stages the voice loop needs:
    chat(messages, tools)        -> LLM turn (OpenAI-style tool calling)
    transcribe(pcm_int16, rate)  -> STT (Whisper)
    synthesize(text)             -> TTS; returns WAV bytes, or None if it
                                    already played via the system voice command
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import unicodedata
import wave
from types import SimpleNamespace as NS


def _strip_accents(value: str) -> str:
    """Fold accents so keyword matching survives Spanish and French diacritics."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))

# Sensible defaults per backend. Any of these can be overridden in .env.
PRESETS = {
    "groq": {
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
        # 70b = reliable tool-calling; swap to llama-3.1-8b-instant for lower latency.
        "llm_model": "llama-3.3-70b-versatile",
        "stt_model": "whisper-large-v3-turbo",
        "tts_model": "canopylabs/orpheus-v1-english",
        "tts_voice": "troy",
    },
    "openai": {
        "base_url": None,                # SDK default endpoint
        "api_key_env": "OPENAI_API_KEY",
        "llm_model": "gpt-4o-mini",
        "stt_model": "whisper-1",
        "tts_model": "tts-1",
        "tts_voice": "alloy",
    },
}

DEFAULT_STT_PROMPT = (
    "Aurora Hotel reservations conversation in English or Spanish. "
    "Hotel vocabulary: reservation, booking, check-in, check-out, cancellation policy, "
    "pet policy, parking, breakfast, accessibility, habitación, reserva, política de "
    "cancelación, mascotas, estacionamiento, desayuno, accesibilidad."
)


def _env_or_default(key: str, default: str) -> str:
    """Return a non-empty environment override or the provider preset.

    A copied .env template can leave a comment after an empty assignment.
    Some dotenv versions preserve that comment as the value, which would send
    an invalid model ID to the provider.
    """
    value = os.getenv(key, "").strip()
    if not value or value.startswith("#"):
        return default
    return value


class Provider:
    """Configured client for one backend. Read from .env on construction."""

    def __init__(self, name: str | None = None):
        name = (name or os.getenv("PROVIDER", "groq")).lower()
        if name not in PRESETS:
            raise ValueError(f"Unknown PROVIDER {name!r}; use one of {list(PRESETS)}")
        self.name = name
        p = PRESETS[name]

        api_key = os.getenv(p["api_key_env"])
        if not api_key:
            raise RuntimeError(f"Set {p['api_key_env']} in your .env (PROVIDER={name})")
        from openai import OpenAI  # lazy: the mock path needs no SDK installed
        self.client = OpenAI(api_key=api_key, base_url=p["base_url"])

        # Per-stage overrides fall back to the preset.
        self.llm_model = _env_or_default("LLM_MODEL", p["llm_model"])
        self.stt_model = _env_or_default("STT_MODEL", p["stt_model"])
        self.stt_prompt = _env_or_default("STT_PROMPT", DEFAULT_STT_PROMPT)
        self.tts_model = _env_or_default("TTS_MODEL", p["tts_model"])
        self.tts_voice = _env_or_default("TTS_VOICE", p["tts_voice"])
        self.tts_instructions = os.getenv("TTS_INSTRUCTIONS")
        # "provider" = cloud TTS; "system" = local system voice command.
        self.tts_backend = os.getenv("TTS_BACKEND", "provider").lower()

    # --- LLM ---
    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        tool_choice=None,
    ):
        """One chat-completion call. Returns the raw SDK response."""
        return self.client.chat.completions.create(
            model=self.llm_model,
            messages=messages,
            tools=tools or None,
            tool_choice=(tool_choice or "auto") if tools else None,
            temperature=0.3,
        )

    # --- STT ---
    def transcribe(self, pcm_int16: bytes, sample_rate: int = 16000) -> str:
        """Transcribe raw 16-bit mono PCM via Whisper."""
        wav = _pcm_to_wav(pcm_int16, sample_rate)
        wav.name = "turn.wav"  # SDK infers format from the filename
        transcription_args = {
            "model": self.stt_model,
            "file": wav,
            "response_format": "text",
        }
        if self.stt_prompt:
            transcription_args["prompt"] = self.stt_prompt
        resp = self.client.audio.transcriptions.create(
            **transcription_args,
        )
        return (resp if isinstance(resp, str) else resp.text).strip()

    # --- TTS ---
    def synthesize(self, text: str) -> bytes | None:
        """Return WAV bytes for `text`, or None if played directly by the OS."""
        if self.tts_backend == "system":
            subprocess.run([os.getenv("SYSTEM_TTS_CMD", "say"), text], check=False)
            return None
        speech_args = {
            "model": self.tts_model,
            "voice": self.tts_voice,
            "input": text,
            "response_format": "wav",
        }
        if self.tts_instructions:
            speech_args["instructions"] = self.tts_instructions
        resp = self.client.audio.speech.create(
            **speech_args,
        )
        return resp.content


# --- audio helpers ---

def _pcm_to_wav(pcm_int16: bytes, sample_rate: int) -> io.BytesIO:
    """Wrap raw 16-bit mono PCM samples into an in-memory WAV file."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit
        w.setframerate(sample_rate)
        w.writeframes(pcm_int16)
    buf.seek(0)
    return buf


# --- Mock backend: full offline end-to-end, no network / key / SDK ---

class MockProvider:
    """Drop-in stand-in for Provider. Rule-based LLM, scripted STT, no-op TTS.

    Same interface (chat / transcribe / synthesize) so voice_loop.py and
    agent.py can't tell the difference. Use for rehearsals, CI, and testing the
    loop without touching Groq/OpenAI. Enable with PROVIDER=mock.
    """

    name = "mock"

    def __init__(self):
        self.llm_model = "mock-llm"
        self.stt_model = "mock-stt"
        self.tts_model = "mock-tts"
        self.tts_voice = "mock"
        self.tts_backend = os.getenv("TTS_BACKEND", "print").lower()
        # Scripted transcripts for mic mode (there's no offline STT); cycles.
        self._stt_script = [
            "I need a room from August 12 to August 14 for two guests.",
            "The Deluxe King, please.",
            "Book it for Priya Shah, priya@example.com.",
            "Yes, I confirm.",
            "Can I speak to a person?",
            "Goodbye",
        ]
        self._stt_i = 0
        self._pending_booking: dict | None = None

    def chat(self, messages: list[dict], tools=None, tool_choice=None):
        """Rule-based reply mimicking OpenAI-style tool calling."""
        last = messages[-1]
        language = _mock_language(messages)
        forced_tool = _tool_choice_name(tool_choice)
        if last.get("role") == "user" and forced_tool:
            original = last.get("content") or ""
            if forced_tool == "search_hotel_knowledge":
                return _mk_tool(forced_tool, {"query": original})
            if forced_tool == "get_room_service_hours":
                return _mk_tool(forced_tool, {"meal": _mock_meal(original.lower())})
        # After a tool ran, speak a reply built from its result. The mock
        # dispatches on the TOOL NAME, not on the English text of the result,
        # so it keeps working when the result is Spanish or French.
        if last.get("role") == "tool":
            result = last["content"]
            previous_tool = _previous_tool_name(messages)
            if previous_tool == "set_language":
                switched = _mock_switched_language(result.lower())
                if switched:
                    return self._after_language_switch(switched, _last_user_text(messages))
                return _mk_text(_LANGUAGE_GREETING[language])
            if previous_tool == "search_hotel_knowledge":
                tool_args = _previous_tool_arguments(messages)
                return _mk_text(_grounded_policy_reply(result, language, tool_args.get("query", "")))
            if previous_tool == "check_availability":
                # A rate is a proper noun and is never translated, so "$" marks a
                # result that actually lists rooms.
                follow_up = (_AVAILABILITY_FOLLOW_UP if "$" in result
                             else _NO_AVAILABILITY_FOLLOW_UP)[language]
                return _mk_text(f"{result} {follow_up}")
            if previous_tool == "create_booking":
                self._pending_booking = None
            return _mk_text(result)

        text = (last.get("content") or "").lower()
        # Accent-stripped copy so Spanish and French confirm/reserve verbs
        # ("resérvela", "confírmalo", "réservez") match the plain keyword lists.
        norm = _strip_accents(text)
        tokens = set(re.findall(r"[\wáéíóúüñçàèêôîû]+", text, flags=re.UNICODE))
        requested_language = _mock_language_request(text)
        if requested_language:
            return _mk_tool("set_language", {"language": requested_language})
        # Restricted advice is checked before every other intent so a caller
        # cannot smuggle it in behind a booking or off-topic phrase.
        if _mock_restricted_advice(text):
            return _mk_text(_RESTRICTED_ADVICE[language])
        if _mock_room_service_request(text):
            return _mk_tool("get_room_service_hours", {"meal": _mock_meal(text)})
        if _mock_knowledge_request(text):
            return _mk_tool("search_hotel_knowledge", {"query": last.get("content") or ""})
        if any(w in text for w in ("bye", "goodbye", "that's all", "thats all",
                                   "nothing else", "no thanks", "hang up", "adiós",
                                   "adios", "au revoir")):
            return _mk_tool("end_call", {})
        # Checked after end_call so "no thanks" still hangs up. A bare courtesy
        # must acknowledge without changing language or inventing an answer.
        if _mock_courtesy(text, tokens):
            return _mk_text(_COURTESY_REPLY[language])
        if _mock_off_topic(text):
            return _mk_text(_OFF_TOPIC[language])
        if any(phrase in text for phrase in (
            "another reservation", "another guest", "other guest", "someone else's",
        )):
            return _mk_text(_PRIVACY_REFUSAL[language])
        if tokens & {"human", "person", "representative", "agent", "operator",
                     "persona", "recepción", "réception", "reception"}:
            return _mk_tool("transfer_to_human", {})
        if any(w in text for w in ("change", "cancel", "modify", "front desk",
                                   "annuler", "modifier")):
            return _mk_tool("transfer_to_human", {})
        if self._pending_booking and _mock_booking_confirmation(norm):
            return _mk_tool("create_booking", self._pending_booking)
        if any(w in norm for w in ("book", "reserve", "reserv", "yes", "si", "oui",
                                   "confirm")) and any(
            w in norm for w in ("name", "email", "@", "phone", "priya", "shah",
                                "nombre", "nom")
        ):
            booking = _mock_booking_details(messages)
            self._pending_booking = booking
            return _mk_text(_BOOKING_CONFIRMATION_REQUEST[language].format(**booking))
        selected_room = _mock_selected_room(text)
        if selected_room and not any(
            term in norm
            for term in ("august", "aout", "guest", "person", "huesped")
        ):
            return _mk_text(_ROOM_SELECTED_REPLY[language].format(room=selected_room))
        if any(w in text for w in (
            "room", "hotel", "stay", "book", "reservation", "guests", "guest",
            "habitación", "habitacion", "reserva", "personas", "huéspedes", "huespedes",
            "chambre", "chambres", "réservation", "reservation", "personnes", "nuits",
        )):
            availability = _mock_booking_details(messages)
            args = {
                "check_in": availability["check_in"],
                "check_out": availability["check_out"],
                "guests": availability["guests"],
            }
            if availability["room_type"]:
                args["room_type"] = availability["room_type"]
            return _mk_tool("check_availability", args)
        return _mk_text(_OFF_TOPIC[language])

    def _after_language_switch(self, language: str, original_text: str):
        """Re-run the caller's original intent in the newly selected language."""
        original = original_text.lower()
        if _mock_restricted_advice(original):
            return _mk_text(_RESTRICTED_ADVICE[language])
        if _mock_room_service_request(original):
            return _mk_tool("get_room_service_hours", {"meal": _mock_meal(original)})
        if _mock_knowledge_request(original):
            return _mk_tool("search_hotel_knowledge", {"query": original})
        if _mock_off_topic(original):
            return _mk_text(_OFF_TOPIC[language])
        return _mk_text(_LANGUAGE_GREETING[language])

    def transcribe(self, pcm_int16: bytes, sample_rate: int = 16000) -> str:
        """No offline STT  -  return the next scripted phrase (rehearsal mode)."""
        phrase = self._stt_script[self._stt_i % len(self._stt_script)]
        self._stt_i += 1
        return phrase

    def synthesize(self, text: str) -> bytes | None:
        """No cloud TTS. Optionally use a local voice command; else print-only."""
        if self.tts_backend == "system":
            subprocess.run([os.getenv("SYSTEM_TTS_CMD", "say"), text], check=False)
        return None  # voice_loop already prints the agent's text


# --- Mock reply tables. One row per caller-visible behaviour, three languages. ---

_OFF_TOPIC = {
    "en": "I can only help with hotel reservations. Are you looking to book, change, or cancel a stay?",
    "es": "Solo puedo ayudar con reservas de hotel. ¿Quiere reservar, cambiar o cancelar una estancia?",
    "fr": "Je peux seulement vous aider avec les réservations de l'hôtel. Souhaitez-vous réserver, modifier ou annuler un séjour ?",
}

_RESTRICTED_ADVICE = {
    "en": "I'm sorry, I'm not able to give medical, legal, or financial advice. "
          "Please speak with a qualified professional about that. "
          "I can help with hotel reservations if you would like to book, change, or cancel a stay.",
    "es": "Lo siento, no puedo dar consejos médicos, legales ni financieros. "
          "Consulte a un profesional calificado sobre eso. "
          "Puedo ayudarle con reservas de hotel si desea reservar, cambiar o cancelar una estancia.",
    "fr": "Je suis désolé, je ne peux pas donner de conseils médicaux, juridiques ou financiers. "
          "Veuillez consulter un professionnel qualifié à ce sujet. "
          "Je peux vous aider avec les réservations de l'hôtel si vous souhaitez réserver, "
          "modifier ou annuler un séjour.",
}

_PRIVACY_REFUSAL = {
    "en": "I cannot disclose another guest's information. I can only help with your own hotel reservation.",
    "es": "No puedo revelar datos de otro huésped. Solo puedo ayudar con su propia reserva de hotel.",
    "fr": "Je ne peux pas divulguer les informations d'un autre client. Je peux seulement vous aider avec votre propre réservation.",
}

_LANGUAGE_GREETING = {
    "en": "Of course. I can continue in English with your Aurora Hotel reservation.",
    "es": "Claro. Puedo ayudarle con una reserva en Aurora Hotel.",
    "fr": "Bien sûr. Je peux continuer en français pour votre réservation à l'Aurora Hotel.",
}

# The phrasing layer owns the follow-up question, so the tool result stays data.
_AVAILABILITY_FOLLOW_UP = {
    "en": "Would you like me to book one of these?",
    "es": "¿Quiere que reserve una de estas habitaciones?",
    "fr": "Souhaitez-vous que je réserve l'une de ces chambres ?",
}

_NO_AVAILABILITY_FOLLOW_UP = {
    "en": "Would you like me to transfer you to the front desk?",
    "es": "¿Quiere que le transfiera a la recepción?",
    "fr": "Souhaitez-vous que je vous transfère à la réception ?",
}

_ROOM_SELECTED_REPLY = {
    "en": "I have selected the {room}. What name and phone number or email should I use?",
    "es": "He seleccionado {room}. ¿Qué nombre y teléfono o correo electrónico debo usar?",
    "fr": "J'ai sélectionné {room}. Quel nom et quel numéro de téléphone ou e-mail dois-je utiliser ?",
}

_BOOKING_CONFIRMATION_REQUEST = {
    "en": "Please confirm: {room_type} from {check_in} to {check_out} for "
          "{guests} guests, under {guest_name}, using {contact}.",
    "es": "Confirme: {room_type} del {check_in} al {check_out} para "
          "{guests} huéspedes, a nombre de {guest_name}, con {contact}.",
    "fr": "Veuillez confirmer : {room_type} du {check_in} au {check_out} pour "
          "{guests} personnes, au nom de {guest_name}, avec {contact}.",
}

_LANGUAGE_REQUEST_PHRASES = {
    "es": (
        "speak spanish", "switch to spanish", "spanish please", "in spanish",
        "habla español", "hable español", "en español", "parlez espagnol",
    ),
    "fr": (
        "speak french", "switch to french", "french please", "in french",
        "parlez français", "parlez francais", "parle français", "parle francais",
        "en français", "en francais", "hable francés", "habla francés",
        "hable frances", "habla frances",
    ),
    "en": (
        "speak english", "switch to english", "switch back to english",
        "back to english", "return to english", "english please", "english again",
        "habla inglés", "hable inglés", "en inglés", "habla ingles",
        "parlez anglais", "en anglais",
    ),
}

# Symptom, dosage, legal, and money terms the agent must never advise on.
_RESTRICTED_ADVICE_TERMS = (
    # medical
    "medical advice", "diagnose", "diagnosis", "symptom", "symptoms", "medication",
    "medicine", "dosage", "dose", "mg of", "ibuprofen", "aspirin", "antibiotic",
    "prescription", "should i take", "chest pain", "allergic reaction", "blood pressure",
    "consejo médico", "consejo medico", "medicamento", "dosis", "síntomas", "sintomas",
    "conseil médical", "conseil medical", "médicament", "medicament", "posologie",
    # legal
    "legal advice", "lawsuit", "sue ", "sue the", "liable", "liability", "my rights",
    "contract law", "is it legal", "legally binding",
    "consejo legal", "demandar", "responsabilidad legal",
    "conseil juridique", "poursuivre en justice", "responsabilité légale",
    # financial
    "financial advice", "investment advice", "should i invest", "invest in", "stock",
    "stocks", "crypto", "bitcoin", "tax advice", "taxes", "mortgage", "insurance claim",
    "retirement", "consejo financiero", "invertir", "impuestos", "hipoteca",
    "conseil financier", "investir", "impôts", "impots", "hypothèque",
)

_ROOM_SERVICE_PHRASES = (
    "room service", "room-service", "in-room dining", "in room dining",
    "servicio a la habitación", "servicio a la habitacion",
    "servicio de habitación", "servicio de habitacion",
    "service en chambre", "service à la chambre", "service a la chambre",
    "service d'étage", "service d etage",
)

_MEAL_PHRASES = (
    ("breakfast", ("breakfast", "desayuno", "petit-déjeuner", "petit dejeuner")),
    ("lunch", ("lunch", "almuerzo", "déjeuner", "dejeuner")),
    ("dinner", ("dinner", "supper", "cena", "dîner", "diner")),
)

_COURTESY_PHRASES = (
    "thank you", "thanks", "gracias", "merci", "much appreciated",
)

_COURTESY_REPLY = {
    "en": "You're very welcome. Is there anything else I can help with for your reservation?",
    "es": "Con mucho gusto. ¿Hay algo más en lo que pueda ayudarle con su reserva?",
    "fr": "Je vous en prie. Puis-je vous aider avec autre chose pour votre réservation ?",
}


def _mk_text(content: str):
    return NS(choices=[NS(message=NS(content=content, tool_calls=None))])


def _mk_tool(name: str, args: dict):
    tc = NS(id=f"call_{name}", type="function",
            function=NS(name=name, arguments=json.dumps(args)))
    return NS(choices=[NS(message=NS(content=None, tool_calls=[tc]))])


def _tool_choice_name(tool_choice) -> str | None:
    if not isinstance(tool_choice, dict):
        return None
    function = tool_choice.get("function") or {}
    return function.get("name")


def _last_user_text(messages: list[dict]) -> str:
    return next(
        (message.get("content") or "" for message in reversed(messages) if message.get("role") == "user"),
        "",
    )


def _mock_language(messages: list[dict]) -> str:
    """Read the language the router injected into the system prompt."""
    system = messages[0].get("content", "") if messages else ""
    for code, name in (("es", "Spanish"), ("fr", "French")):
        if f"Current response language: {name}" in system:
            return code
    return "en"


def _mock_switched_language(tool_result: str) -> str | None:
    """Map a set_language tool result back to its language code."""
    for code, name in (("en", "english"), ("es", "spanish"), ("fr", "french")):
        if tool_result.startswith(f"response language set to {name}"):
            return code
    return None


def _mock_language_request(text: str) -> str | None:
    """Detect an explicit request to switch language. French before Spanish is
    not required here because the phrase lists do not overlap."""
    for code, phrases in _LANGUAGE_REQUEST_PHRASES.items():
        if any(phrase in text for phrase in phrases):
            return code
    return None


def _mock_restricted_advice(text: str) -> bool:
    return any(term in text for term in _RESTRICTED_ADVICE_TERMS)


def _mock_courtesy(text: str, tokens: set[str]) -> bool:
    """True only for a bare thank-you, never for courtesy plus a real request."""
    return len(tokens) <= 3 and any(phrase in text for phrase in _COURTESY_PHRASES)


def _mock_room_service_request(text: str) -> bool:
    return any(phrase in text for phrase in _ROOM_SERVICE_PHRASES)


def _mock_meal(text: str) -> str:
    for meal, phrases in _MEAL_PHRASES:
        if any(phrase in text for phrase in phrases):
            return meal
    return "all"


def _mock_knowledge_request(text: str) -> bool:
    if _mock_room_service_request(text):
        return False  # live operational hours belong to the room-service tool
    return any(word in text for word in (
        "cancellation policy", "cancel policy", "check-in", "check in", "check-out",
        "check out", "parking", "pets", "pet policy", "breakfast", "accessible",
        "accessibility", "policy", "estacionamiento", "mascotas", "desayuno",
        "politique", "annulation", "animaux", "chien", "stationnement", "voiturier",
        "petit-déjeuner", "petit dejeuner", "accessibilité", "accessibilite",
    ))


def _mock_off_topic(text: str) -> bool:
    return any(word in text for word in (
        "weather", "news", "sports", "joke", "trivia", "clima", "noticias",
        "météo", "meteo", "nouvelles", "blague",
    ))


def _mock_booking_confirmation(normalized: str) -> bool:
    return any(
        phrase in normalized
        for phrase in (
            "yes i confirm", "yes, i confirm", "i confirm",
            "si confirmo", "confirmo",
            "oui je confirme", "oui, je confirme", "je confirme",
        )
    )


def _mock_selected_room(text: str) -> str | None:
    normalized = _strip_accents(text.lower())
    for terms, room in (
        (("deluxe king", "king deluxe"), "Deluxe King"),
        (("family double", "double familiale"), "Family Double"),
        (("accessible queen", "queen accessible"), "Accessible Queen"),
        (("standard queen", "queen standard"), "Standard Queen"),
    ):
        if any(term in normalized for term in terms):
            return room
    return None


def _mock_booking_details(messages: list[dict]) -> dict:
    """Extract demo booking fields instead of replacing caller data with fixtures."""
    user_texts = [
        str(message.get("content") or "")
        for message in messages
        if message.get("role") == "user"
    ]
    combined = " ".join(user_texts)
    normalized = _strip_accents(combined.lower())

    room_type = ""
    for text in reversed(user_texts):
        selected = _mock_selected_room(text)
        if selected:
            room_type = selected
            break

    email_match = re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", combined)
    contact = email_match.group(0) if email_match else ""
    guest_name = ""
    if email_match:
        before_email = combined[:email_match.start()].rstrip(" ,")
        name_matches = re.findall(
            r"\b(?:for|pour|para)\s+([^,@.!?]+?)\s*$",
            before_email,
            flags=re.IGNORECASE,
        )
        if name_matches:
            guest_name = re.sub(
                r"\s+at$",
                "",
                name_matches[-1].strip(),
                flags=re.IGNORECASE,
            )

    check_in, check_out = "August 12", "August 14"
    if "12 aout" in normalized and "14 aout" in normalized:
        check_in, check_out = "12 août", "14 août"

    return {
        "check_in": check_in,
        "check_out": check_out,
        "guests": 2,
        "room_type": room_type,
        "guest_name": guest_name,
        "contact": contact,
    }


def _previous_tool_name(messages: list[dict]) -> str:
    """Name of the tool whose result is the last message. Language independent."""
    if len(messages) < 2:
        return ""
    calls = messages[-2].get("tool_calls") or []
    if not calls:
        return ""
    return calls[0].get("function", {}).get("name", "")


def _previous_tool_arguments(messages: list[dict]) -> dict:
    if len(messages) < 2:
        return {}
    calls = messages[-2].get("tool_calls") or []
    if not calls:
        return {}
    try:
        return json.loads(calls[0]["function"].get("arguments") or "{}")
    except (json.JSONDecodeError, KeyError, TypeError):
        return {}


# Each topic is keyed by the terms that appear in the caller's query. Every
# sentence below restates a fact from hotel_policies.md, so the reply the caller
# hears and the grounding source reported in telemetry stay in agreement.
_POLICY_TOPICS = (
    (
        ("cancel", "annulation", "annuler"),
        {
            "en": "You may cancel without charge until 6:00 PM local hotel time two days before arrival. Prepaid promotional rates are non-refundable.",
            "es": "Puede cancelar sin cargo hasta las 6:00 PM, hora local del hotel, dos días antes de la llegada. Las tarifas promocionales prepagadas no son reembolsables.",
            "fr": "Vous pouvez annuler sans frais jusqu'à 18h00, heure locale de l'hôtel, deux jours avant l'arrivée. Les tarifs promotionnels prépayés ne sont pas remboursables.",
        },
    ),
    (
        ("parking", "estacionamiento", "stationnement", "valet", "voiturier"),
        {
            "en": "Self-parking is $28 per night, and valet parking is $42 per night. Electric vehicle charging is first-come.",
            "es": "El estacionamiento cuesta $28 por noche y el servicio de valet cuesta $42 por noche. La carga para vehículos eléctricos es por orden de llegada.",
            "fr": "Le stationnement libre-service coûte 28 $ par nuit et le service voiturier 42 $ par nuit. La recharge pour véhicules électriques est disponible par ordre d'arrivée.",
        },
    ),
    (
        ("accessib", "accesib"),
        {
            "en": "Accessible rooms can include roll-in showers, visual alarms, and lowered fixtures. Please request the features you need before booking so we can confirm availability.",
            "es": "Las habitaciones accesibles pueden incluir duchas sin escalón, alarmas visuales y accesorios a menor altura. Solicite las características que necesita antes de reservar para confirmar la disponibilidad.",
            "fr": "Les chambres accessibles peuvent comprendre des douches de plain-pied, des alarmes visuelles et des équipements abaissés. Merci de demander les aménagements nécessaires avant de réserver afin que nous puissions confirmer la disponibilité.",
        },
    ),
    (
        ("pet", "dog", "mascota", "animaux", "animal", "chien"),
        {
            "en": "Up to two dogs are allowed per room, with a 50-pound limit per dog and a $75 cleaning fee per stay.",
            "es": "Se permiten hasta dos perros por habitación, con un límite de 50 libras por perro y una tarifa de limpieza de $75 por estancia.",
            "fr": "Jusqu'à deux chiens sont admis par chambre, avec une limite de 50 livres par chien et des frais de nettoyage de 75 $ par séjour.",
        },
    ),
    (
        ("breakfast", "desayuno", "petit-déjeuner", "petit dejeuner"),
        {
            "en": "Breakfast is served from 6:30 AM to 10:30 AM and is included only when the selected rate says so.",
            "es": "El desayuno se sirve de 6:30 AM a 10:30 AM y solo está incluido cuando la tarifa lo indica.",
            "fr": "Le petit-déjeuner est servi de 6h30 à 10h30 et n'est inclus que lorsque le tarif choisi le précise.",
        },
    ),
    (
        ("check-in", "check in", "check-out", "check out", "arrivée", "arrivee", "départ", "depart"),
        {
            "en": "Check-in begins at 3:00 PM and check-out is at 11:00 AM.",
            "es": "La entrada comienza a las 3:00 PM y la salida es a las 11:00 AM.",
            "fr": "L'arrivée se fait à partir de 15h00 et le départ à 11h00.",
        },
    ),
)

_POLICY_FALLBACK = {
    "en": "I found the relevant Aurora Hotel policy and can help apply it to your reservation.",
    "es": "Encontré la política de Aurora Hotel y puedo ayudarle con los detalles de su reserva.",
    "fr": "J'ai trouvé la politique correspondante de l'Aurora Hotel et je peux vous aider pour votre réservation.",
}


def _grounded_policy_reply(result: str, language: str, query: str) -> str:
    topic = query.lower()
    for terms, replies in _POLICY_TOPICS:
        if any(term in topic for term in terms):
            return replies[language]
    return _POLICY_FALLBACK[language]


def make_provider(name: str | None = None):
    """Factory: returns MockProvider for PROVIDER=mock, else a live Provider."""
    name = (name or os.getenv("PROVIDER", "groq")).lower()
    if name == "mock":
        return MockProvider()
    return Provider(name)
