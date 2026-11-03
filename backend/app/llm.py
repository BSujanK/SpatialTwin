"""LLM provider chain: Qualcomm Cloud AI 100 -> Anthropic -> (caller falls back to scripted).

    chat(system, messages, max_tokens) -> (text, engine_label) | None

Qualcomm is called through its OpenAI-compatible API (POST {endpoint}/chat/completions, Bearer auth)
with httpx. If that fails and Qualcomm's `imagine` SDK is installed, the SDK is tried as a fallback.
Secrets are read from the environment only (backend/.env is loaded without overriding real env vars)
and are never logged or included in returned text.
"""
from __future__ import annotations

import logging
import os
import re
import threading
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
RETRY_DELAY_S = 0.5
log = logging.getLogger("spatialtwin.llm")
COOLDOWN_S = 30.0 # after a provider fails, skip it for a while so the demo isn't slowed by timeouts

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
        for attempt in (1, 2):
            r = c.post(f"{_endpoint()}/chat/completions", json=body, headers=headers)
            if attempt == 1 and (r.status_code == 429 or r.status_code >= 500):
                log.info("qualcomm HTTP %s, retrying once in %.1fs", r.status_code, RETRY_DELAY_S)
                time.sleep(RETRY_DELAY_S)
                continue
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
    except Exception as http_err:
        try:
            return _qualcomm_sdk(system, messages, max_tokens)
        except Exception:
            raise http_err  # report the real HTTP failure, not a missing-SDK ImportError


def _anthropic(system: str, messages: list[dict], max_tokens: int) -> Optional[str]:
    import anthropic

    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"), timeout=TIMEOUT_S, max_retries=0)
    resp = client.messages.create(model=anthropic_model(), max_tokens=max_tokens, system=system, messages=messages)
    return "".join(getattr(b, "text", "") for b in resp.content).strip()


_FUNCS = {"qualcomm": _qualcomm, "anthropic": _anthropic}


def _why(e: Exception) -> str:
    """Short, key-free description of a failure for the log."""
    if isinstance(e, httpx.HTTPStatusError):
        return f"HTTP {e.response.status_code}"
    return type(e).__name__


def chat(system: str, messages: list[dict], max_tokens: int = 200, background: bool = False) -> Optional[tuple[str, str]]:
    """Try each configured provider in order. Returns (text, engine_label) or None.

    Only connection errors and timeouts from a foreground (copilot) call put a provider on the 30 s
    skip list. HTTP errors and any background failure never disable a provider.
    """
    kind = "background" if background else "copilot"
    for name in providers():
        try:
            text = _FUNCS[name](system, messages, max_tokens)
            if text:
                log.info("%s call answered by %s", kind, name)
                return text, engine_label(name)
            log.info("%s call: %s returned empty text, falling back", kind, name)
        except Exception as e:
            hard = isinstance(e, httpx.TransportError)  # connect errors and timeouts
            log.info("%s call: %s failed (%s)%s, falling back", kind, name, _why(e),
                     f"; skipping it for {COOLDOWN_S:.0f}s" if hard and not background else "")
            if hard and not background:
                _down_until[name] = time.time() + COOLDOWN_S
    return None


# ---------- background work (root-cause analysis) ----------
class BackgroundWorker:
    """One worker thread, newest job first, jobs older than max_age are dropped.
    Keeps background LLM calls from ever competing with the copilot for the provider."""

    def __init__(self, max_age: float = 60.0):
        self.max_age = max_age
        self._jobs: list[tuple[float, object]] = []
        self._cv = threading.Condition()
        self._thread: Optional[threading.Thread] = None

    def submit(self, fn) -> None:
        with self._cv:
            self._jobs.append((time.time(), fn))
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()
            self._cv.notify()

    def _run(self) -> None:
        while True:
            with self._cv:
                if not self._cv.wait_for(lambda: self._jobs, timeout=30):
                    self._thread = None
                    return
                ts, fn = self._jobs.pop()  # newest first
                stale = time.time() - ts > self.max_age
                if stale:
                    log.info("dropping stale background job")
                    self._jobs = [j for j in self._jobs if time.time() - j[0] <= self.max_age]
            if not stale:
                try:
                    fn()
                except Exception:
                    pass


worker = BackgroundWorker()


def warm_up() -> None:
    """Fire one tiny call in the background so the first live copilot reply is fast."""
    if not providers():
        return

    def _go():
        chat("Reply with one word.", [{"role": "user", "content": "ready?"}], max_tokens=5, background=True)

    threading.Thread(target=_go, daemon=True).start()
