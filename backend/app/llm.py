"""LLM provider chain: Qualcomm Cloud AI 100 -> Anthropic -> (caller falls back to scripted).

    chat(system, messages, max_tokens) -> (text, engine_label) | None

Qualcomm is called through its OpenAI-compatible API (POST {endpoint}/chat/completions, Bearer auth)
with httpx. If that fails and Qualcomm's `imagine` SDK is installed, the SDK is tried as a fallback.
Secrets are read from the environment only (backend/.env is loaded without overriding real env vars)
and are never logged or included in returned text.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Optional

import httpx

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)
except Exception:  # python-dotenv missing: real env vars still work
    pass

DEFAULT_ENDPOINT = "https://aisuite.cirrascale.com/apis/v2"
DEFAULT_QUALCOMM_MODEL = "Llama-3.3-70B"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5"
TIMEOUT_S = 8.0
COOLDOWN_S = 30.0  # after a provider fails, skip it for a while so the demo isn't slowed by timeouts

QUALCOMM_LABEL = "Qualcomm Cloud AI 100"
SCRIPTED_ENGINE = "Scripted fallback"

_transport: Optional[httpx.BaseTransport] = None  # tests inject httpx.MockTransport here
_down_until: dict[str, float] = {}


def set_transport(t: Optional[httpx.BaseTransport]) -> None:
    global _transport
    _transport = t


def reset_state() -> None:
    _down_until.clear()


# ---------- configuration ----------
def qualcomm_model() -> str:
    return os.getenv("QUALCOMM_MODEL") or DEFAULT_QUALCOMM_MODEL


def anthropic_model() -> str:
    return os.getenv("COPILOT_MODEL") or DEFAULT_ANTHROPIC_MODEL


def _endpoint() -> str:
    return (os.getenv("QUALCOMM_ENDPOINT") or DEFAULT_ENDPOINT).rstrip("/")


def _usable(name: str) -> bool:
    return time.time() >= _down_until.get(name, 0.0)


def providers() -> list[str]:
    out = []
    if os.getenv("QUALCOMM_API_KEY") and _usable("qualcomm"):
        out.append("qualcomm")
    if os.getenv("ANTHROPIC_API_KEY") and _usable("anthropic"):
        out.append("anthropic")
    return out


def engine_label(provider: str) -> str:
    if provider == "qualcomm":
        return f"{QUALCOMM_LABEL} · {qualcomm_model()}"
    if provider == "anthropic":
        return f"Anthropic · {anthropic_model()}"
    return SCRIPTED_ENGINE


def ai_status() -> dict:
    """The `ai` block of /api/health."""
    p = (providers() or ["scripted"])[0]
    model = {"qualcomm": qualcomm_model(), "anthropic": anthropic_model()}.get(p)
    return {"provider": p, "model": model, "engine": engine_label(p)}


def available() -> bool:
    return bool(providers())


# ---------- providers ----------
_THINK = re.compile(r"<think>.*?</think>", re.S)


def _clean(text: str) -> str:
    return _THINK.sub("", text or "").strip()


def _qualcomm_http(system: str, messages: list[dict], max_tokens: int) -> Optional[str]:
    body = {
        "model": qualcomm_model(),
        "messages": [{"role": "system", "content": system}] + messages,
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {os.getenv('QUALCOMM_API_KEY')}", "Content-Type": "application/json"}
    with httpx.Client(transport=_transport, timeout=TIMEOUT_S) as c:
        r = c.post(f"{_endpoint()}/chat/completions", json=body, headers=headers)
        r.raise_for_status()
        return _clean(r.json()["choices"][0]["message"]["content"])


def _qualcomm_sdk(system: str, messages: list[dict], max_tokens: int) -> Optional[str]:
    """Fallback: Qualcomm's python imagine SDK (optional dependency)."""
    from imagine import ImagineClient  # type: ignore

    client = ImagineClient(endpoint=_endpoint(), api_key=os.getenv("QUALCOMM_API_KEY"), timeout=TIMEOUT_S)
    resp = client.chat(
        messages=[{"role": "system", "content": system}] + messages,
        model=qualcomm_model(), max_tokens=max_tokens, temperature=0.3,
    )
    text = getattr(resp, "first_content", None)
    if text is None:
        text = resp.choices[0].message.content
    return _clean(text)


def _qualcomm(system: str, messages: list[dict], max_tokens: int) -> Optional[str]:
    try:
        return _qualcomm_http(system, messages, max_tokens)
    except Exception:
        return _qualcomm_sdk(system, messages, max_tokens)  # raises if SDK missing/failing


def _anthropic(system: str, messages: list[dict], max_tokens: int) -> Optional[str]:
    import anthropic

    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"), timeout=TIMEOUT_S, max_retries=0)
    resp = client.messages.create(model=anthropic_model(), max_tokens=max_tokens, system=system, messages=messages)
    return "".join(getattr(b, "text", "") for b in resp.content).strip()


_FUNCS = {"qualcomm": _qualcomm, "anthropic": _anthropic}


def chat(system: str, messages: list[dict], max_tokens: int = 200) -> Optional[tuple[str, str]]:
    """Try each configured provider in order. Returns (text, engine_label) or None."""
    for name in providers():
        try:
            text = _FUNCS[name](system, messages, max_tokens)
            if text:
                return text, engine_label(name)
        except Exception:
            pass
        _down_until[name] = time.time() + COOLDOWN_S
    return None
