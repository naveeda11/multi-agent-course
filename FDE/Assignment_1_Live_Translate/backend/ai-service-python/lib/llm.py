"""
lib/llm.py - the LLM translation call
=====================================
One job: turn an English string into Mexican Spanish using an LLM.

Provider: Google Gemini via the `google-genai` SDK (async client). The provider
is swappable - the API key and model come from the environment, so switching to
another provider only touches this file.

  - The PROMPT pins the register to Mexican Spanish (es-MX), not
    generic/Castilian Spanish, and asks for ONLY the translation.
  - Numbers, prices ($), URLs, and product/model codes are kept unchanged.
  - The returned string is cleaned of stray wrapping quotes/whitespace.

FAIL LOUD: this call is NOT wrapped in a try/except that returns `text` on
error. If the provider fails, the exception propagates so the caller returns a
502. Silently returning the untranslated input is an automatic fail (and a real
production bug - it ships English while looking healthy).
"""
import os

from google import genai
from google.genai import types

MODEL_DEFAULT = os.getenv("MODEL", "gemini-2.5-flash")

# Language-name hints so the prompt reads naturally for whatever `target` we get.
# The assignment default is es-MX; this map powers the multi-language stretch goal.
# Any code not listed still works via the BCP-47 fallback below.
_TARGET_NAMES = {
    "es-MX": "Mexican Spanish (español mexicano, es-MX)",
    "es-ES": "Castilian/European Spanish (español de España, es-ES)",
    "es-AR": "Argentine Spanish (español rioplatense, es-AR)",
    "es": "neutral Latin American Spanish",
    "pt-BR": "Brazilian Portuguese (português do Brasil)",
    "pt-PT": "European Portuguese (português de Portugal)",
    "fr": "French",
    "fr-CA": "Canadian/Québécois French",
    "de": "German",
    "it": "Italian",
    "nl": "Dutch",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Simplified Chinese (简体中文)",
    "zh-TW": "Traditional Chinese (繁體中文)",
    "ar": "Modern Standard Arabic",
    "hi": "Hindi",
    "ru": "Russian",
    "tr": "Turkish",
    "vi": "Vietnamese",
}


def _system_prompt(target: str) -> str:
    # Known code → a natural language name; unknown code → let the model resolve the
    # BCP-47 tag itself, so any language works without a code change here.
    lang = _TARGET_NAMES.get(target) or f"the language identified by the BCP-47 code '{target}'"
    return (
        f"You are a professional localization translator. Translate the user's "
        f"English text into natural, everyday {lang}. Use the vocabulary, idioms, "
        f"and register a native speaker in that region would actually use - not a "
        f"stiff or literal rendering.\n\n"
        "Rules:\n"
        "- Return ONLY the translation. No preamble, no notes, no explanations, "
        "no wrapping quotation marks.\n"
        "- Keep numbers, prices (e.g. $50, $1,299.00), percentages, dates, URLs, "
        "email addresses, and product/model/SKU codes (e.g. SKU-4471) exactly as "
        "written in the source.\n"
        "- Preserve UI brevity: if the source is a short button/label, keep the "
        "translation just as short.\n"
        "- Do not translate proper brand names unless they have a well-known "
        "localized form."
    )


_client: genai.Client | None = None


def _get_client() -> genai.Client:
    """Lazily build the Gemini client so importing this module never needs a key."""
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set - cannot call the LLM"
            )
        _client = genai.Client(api_key=api_key)
    return _client


def _clean(out: str) -> str:
    out = (out or "").strip()
    # Strip a single layer of wrapping quotes the model may add around the whole string.
    if len(out) >= 2 and out[0] in "\"'“‘«" and out[-1] in "\"'”’»":
        out = out[1:-1].strip()
    return out


async def translate_text(text: str, target: str = "es-MX", model: str = MODEL_DEFAULT) -> str:
    """Return `text` translated into `target` (Mexican Spanish by default)."""
    client = _get_client()
    resp = await client.aio.models.generate_content(
        model=model,
        contents=text,
        config=types.GenerateContentConfig(
            system_instruction=_system_prompt(target),
            temperature=0.2,
            max_output_tokens=2048,
        ),
    )
    translated = _clean(resp.text)
    if not translated:
        # An empty completion is a failure, not a valid translation - fail loud.
        raise RuntimeError("LLM returned an empty translation")
    return translated
