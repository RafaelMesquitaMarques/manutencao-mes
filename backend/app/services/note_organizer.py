"""
Note Organizer — dictated-note tidy-up
======================================
Takes a raw technician note (typically produced by voice dictation, so it comes
in as an unpunctuated run-on) and returns a clean, organized version.

Primary path: the Anthropic API with a small fast model (~1-2s per note; cost
per note is a fraction of a cent). Replaced local Ollama as primary after
CPU-only inference proved too slow (~7-11s warm, ~90s cold — measured).

Fallback chain — the endpoint always returns something usable:
  1. Anthropic API   (fast; needs ANTHROPIC_API_KEY + internet)
  2. Local Ollama    (token-free, on-prem; slow on CPU but works offline)
  3. Local cleanup   (deterministic sentence casing/spacing, no AI)
`ai_used` tells the caller whether an AI (1 or 2) rewrote the note so the UI
can hint when only the basic formatting ran.

Language support: en / fr / es. The model is instructed to keep the note in the
same language it was dictated in and to never invent facts.
"""

from __future__ import annotations

import asyncio
import logging
import re

import httpx
from anthropic import AsyncAnthropic

from app.core.config import settings

logger = logging.getLogger(__name__)

# Small + fast Anthropic model: a note tidy-up needs no reasoning depth, and
# Haiku answers in ~1-2s where the local 3B on CPU took 7-11s warm.
ANTHROPIC_MODEL = "claude-haiku-4-5"
ANTHROPIC_MAX_TOKENS = 1000
# Fail over quickly rather than leaving the technician staring at a spinner:
# short timeout + a single retry (a healthy API answers well under this).
ANTHROPIC_TIMEOUT = 15.0

# ── Ollama fallback ───────────────────────────────────────────────────────────
# CPU inference is slow to start: the very first call after the model is idle
# loads ~2 GB into RAM and can take 80-90s (measured) before generation even
# begins. A tight timeout here silently drops every cold call to the
# local-cleanup fallback (the "AI offline" hint). 120s gives comfortable
# headroom; nginx allows 3600s and the frontend axios has no timeout, so this
# is the only limiting bound.
OLLAMA_TIMEOUT = 120.0

# The ollama container can boot (or pull a model) slower than the backend, so
# the startup warmup retries for a while before giving up.
_WARMUP_RETRY_SEC = 30
_WARMUP_MAX_ATTEMPTS = 10

# Small local models (e.g. llama3.2:3b) happily invent part codes, machine names
# and dates when asked to "organize". These prompts are deliberately strict: only
# reformat, never add. The rules are stated as hard constraints and the model is
# told to reproduce ONLY what the note contains, in the note's own language.
_PROMPTS = {
    "en": (
        "You reformat a maintenance note. Your ONLY job: fix spelling, punctuation and "
        "capitalization, and split distinct actions into short bullet points.\n"
        "STRICT RULES:\n"
        "- Do NOT add, invent, guess or expand anything.\n"
        "- Do NOT drop any detail: every fact, number and machine reference in the "
        "note must appear in the output.\n"
        "- Do NOT add part codes, machine names, dates, headings or fields unless they "
        "appear verbatim in the note.\n"
        "- Keep it at most as long as the original. Every word must come from the note.\n"
        "- Reply in English. Output ONLY the cleaned note, nothing else."
    ),
    "fr": (
        "Tu remets en forme une note de maintenance. Ton SEUL rôle : corriger "
        "l'orthographe, la ponctuation et les majuscules, et séparer les actions "
        "distinctes en puces courtes.\n"
        "RÈGLES STRICTES :\n"
        "- N'ajoute, n'invente, ne devine et n'étoffe RIEN.\n"
        "- Ne supprime AUCUN détail : chaque fait, nombre et référence machine de la "
        "note doit apparaître dans le résultat.\n"
        "- N'ajoute aucun code de pièce, nom de machine, date, titre ou champ qui "
        "n'apparaît pas mot pour mot dans la note.\n"
        "- Reste au plus aussi court que l'original. Chaque mot doit venir de la note.\n"
        "- Réponds en français. Donne UNIQUEMENT la note nettoyée, rien d'autre."
    ),
    "es": (
        "Reformateas una nota de mantenimiento. Tu ÚNICA tarea: corregir la ortografía, "
        "la puntuación y las mayúsculas, y separar las acciones distintas en viñetas "
        "cortas.\n"
        "REGLAS ESTRICTAS:\n"
        "- NO añadas, inventes, adivines ni amplíes nada.\n"
        "- NO omitas ningún detalle: cada hecho, número y referencia a máquina de la "
        "nota debe aparecer en el resultado.\n"
        "- NO añadas códigos de pieza, nombres de máquina, fechas, títulos ni campos que "
        "no aparezcan textualmente en la nota.\n"
        "- Que sea como mucho tan corta como el original. Cada palabra debe venir de la nota.\n"
        "- Responde en español. Devuelve SOLO la nota limpia, nada más."
    ),
}


async def organize_note(text: str, language: str = "en") -> tuple[str, bool]:
    """Return (organized_text, ai_used).

    ai_used=True  → an AI (Anthropic or Ollama fallback) rewrote the note.
    ai_used=False → both AI paths were disabled/unreachable; local cleanup ran.
    """
    lang = language if language in _PROMPTS else "en"
    raw = (text or "").strip()
    if not raw:
        return "", False

    if settings.anthropic_api_key:
        try:
            organized = _strip_preamble((await _call_anthropic(raw, lang)).strip())
            if organized:
                return organized, True
        except Exception as exc:  # noqa: BLE001 — any failure must degrade, never 500
            logger.warning("Anthropic note organize failed (%s) — trying Ollama.", exc)

    if settings.OLLAMA_BASE_URL:
        try:
            organized = _strip_preamble((await _call_ollama(raw, lang)).strip())
            if organized:
                return organized, True
        except Exception as exc:  # noqa: BLE001
            logger.warning("Ollama note organize failed (%s) — using local cleanup.", exc)

    return _local_cleanup(raw), False


async def _call_anthropic(text: str, lang: str) -> str:
    client = AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        timeout=ANTHROPIC_TIMEOUT,
        max_retries=1,
    )
    try:
        resp = await client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=ANTHROPIC_MAX_TOKENS,
            temperature=0.1,
            system=_PROMPTS[lang],
            messages=[{"role": "user", "content": text}],
        )
        return "".join(b.text for b in resp.content if b.type == "text")
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass


def _ollama_keep_alive() -> int | str:
    """How long Ollama keeps the model in RAM after a call.

    Ollama as PRIMARY (no Anthropic key): pin forever (-1) — otherwise nearly
    every real note pays the ~90s cold load; warm_up() pays it once at boot.
    Ollama as FALLBACK: it only serves rare outages, so don't hold 2.6 GB
    permanently — let it unload after 30 idle minutes.
    """
    return -1 if not settings.anthropic_api_key else "30m"


async def warm_up() -> None:
    """Preload the Ollama model when Ollama is the PRIMARY organizer.

    Fire-and-forget at app startup. Skipped entirely when an Anthropic key is
    configured — the fallback doesn't justify pinning ~2.6 GB of RAM. When it
    does run, generating a single token (rather than a prompt-less load) also
    pays llama.cpp's one-time first-inference setup (measured: a fresh load
    answered its first real note in ~33s vs ~7s after). Failure is harmless
    (the first real call just runs cold) and must never crash the app.
    """
    if settings.anthropic_api_key or not settings.OLLAMA_BASE_URL:
        return
    url = settings.OLLAMA_BASE_URL.rstrip("/") + "/api/generate"
    payload = {
        "model": settings.OLLAMA_MODEL,
        "keep_alive": _ollama_keep_alive(),
        "prompt": "ok",
        "stream": False,
        "options": {"num_predict": 1},
    }
    for attempt in range(1, _WARMUP_MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
                resp = await client.post(url, json=payload)
                resp.raise_for_status()
            logger.info("Ollama model %s preloaded (pinned in RAM).", settings.OLLAMA_MODEL)
            return
        except Exception as exc:  # noqa: BLE001 — warmup must never crash startup
            logger.info(
                "Ollama warmup attempt %d/%d failed (%s); retrying in %ds.",
                attempt, _WARMUP_MAX_ATTEMPTS, exc, _WARMUP_RETRY_SEC,
            )
            await asyncio.sleep(_WARMUP_RETRY_SEC)
    logger.warning(
        "Ollama warmup gave up after %d attempts — the first note organize will be slow.",
        _WARMUP_MAX_ATTEMPTS,
    )


async def _call_ollama(text: str, lang: str) -> str:
    url = settings.OLLAMA_BASE_URL.rstrip("/") + "/api/chat"
    payload = {
        "model": settings.OLLAMA_MODEL,
        "stream": False,
        "keep_alive": _ollama_keep_alive(),
        # Low temperature + a hard output cap keep it faithful and fast: a tidied
        # note is never long, and capping num_predict bounds worst-case latency.
        "options": {"temperature": 0.1, "num_predict": 400},
        "messages": [
            {"role": "system", "content": _PROMPTS[lang]},
            {"role": "user", "content": text},
        ],
    }
    async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
    return (data.get("message") or {}).get("content", "")


def _strip_preamble(text: str) -> str:
    """Drop a leading chatty preamble line (e.g. "Voici la note nettoyée :").

    Small models often prepend one despite being told to output only the note.
    We only strip a first line that ENDS with a colon (nothing after it) and is
    followed by more content — a real note line like "Problème : bruit" keeps
    text after the colon and is therefore preserved.
    """
    lines = text.split("\n")
    if len(lines) > 1 and lines[0].rstrip().endswith(":") and any(l.strip() for l in lines[1:]):
        return "\n".join(lines[1:]).strip()
    return text


def _local_cleanup(text: str) -> str:
    """Deterministic, dependency-free tidy-up used when the AI is unavailable.

    Collapses whitespace and capitalizes the first letter of each sentence — enough
    to make raw dictation readable without pretending to be AI.
    """
    cleaned = re.sub(r"\s+", " ", text).strip()
    # Ensure a space after sentence punctuation, then capitalize sentence starts.
    cleaned = re.sub(r"([.!?])([^\s])", r"\1 \2", cleaned)
    parts = re.split(r"(?<=[.!?])\s+", cleaned)
    parts = [p[:1].upper() + p[1:] if p else p for p in parts]
    return " ".join(parts)
