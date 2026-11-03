import json
import time

import httpx
from fastapi.testclient import TestClient

from app import llm
from app.agent import Agent
from app.main import agent as g_agent, app, sim as g_sim
from app.simulator import Simulator

calls = []


def mock(text="Replace the bearing.", status=200):
    calls.clear()

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        if status != 200:
            return httpx.Response(status, json={"error": "nope"})
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": text}}]})

    llm.set_transport(httpx.MockTransport(handler))


def enable(monkeypatch):
    monkeypatch.setenv("QUALCOMM_API_KEY", "secret-test-key")
    monkeypatch.setenv("QUALCOMM_ENDPOINT", "https://qc.example/apis/v2/")


def start(c):
    return c.post("/api/copilot", json={"machine_id": "PUMP-03", "message": "start", "step_index": 0, "history": []}).json()


def test_openai_compatible_request_shape(monkeypatch):
    enable(monkeypatch)
    mock("Hello <think>hmm</think>technician.")
    out = llm.chat("sys", [{"role": "user", "content": "hi"}], max_tokens=50)
    assert out == ("Hello technician.", "Qualcomm Cloud AI 100 · Llama-3.3-70B")
    req = calls[0]
    assert str(req.url) == "https://qc.example/apis/v2/chat/completions"
    assert req.headers["authorization"] == "Bearer secret-test-key"
    body = json.loads(req.content)
    assert body["model"] == "Llama-3.3-70B" and body["max_tokens"] == 50
    assert body["messages"][0] == {"role": "system", "content": "sys"}


def test_model_override_and_health(monkeypatch):
    enable(monkeypatch)
    monkeypatch.setenv("QUALCOMM_MODEL", "Llama-3.1-8B")
    ai = TestClient(app).get("/api/health").json()["ai"]
    assert ai == {"provider": "qualcomm", "model": "Llama-3.1-8B", "engine": "Qualcomm Cloud AI 100 · Llama-3.1-8B"}


def test_copilot_uses_qualcomm(monkeypatch):
    enable(monkeypatch)
    mock("Switch the isolator off and tag it out.")
    g_sim.reset(); g_agent.reset()
    r = start(TestClient(app))
    assert r["source"] == "llm" and r["engine"] == "Qualcomm Cloud AI 100 · Llama-3.3-70B"
    assert r["step"]["safety_warning"] in r["reply"]  # code appends the warning
    g_sim.reset(); g_agent.reset()


def test_error_falls_through_to_anthropic_then_scripted(monkeypatch):
    enable(monkeypatch)
    mock(status=500)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
    import anthropic

    class Fake:
        def __init__(self, **kw):
            self.messages = self

        def create(self, **kw):
            class B:
                text = "from claude"

            class R:
                content = [B()]
            return R()

    monkeypatch.setattr(anthropic, "Anthropic", Fake)
    assert llm.chat("s", [{"role": "user", "content": "q"}]) == ("from claude", "Anthropic · claude-haiku-5-5")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    llm.reset_state()
    assert llm.chat("s", [{"role": "user", "content": "q"}]) is None
    llm.reset_state()
    g_sim.reset(); g_agent.reset()
    r = start(TestClient(app))
    assert r["source"] == "scripted" and r["engine"] == "Scripted fallback"
    g_sim.reset(); g_agent.reset()


def test_cooldown_skips_failed_provider(monkeypatch):
    enable(monkeypatch)
    mock(status=500)
    llm.chat("s", [{"role": "user", "content": "q"}])
    n = len(calls)
    llm.chat("s", [{"role": "user", "content": "q"}])
    assert len(calls) == n  # provider in cooldown, not called again


def test_root_cause_event_emitted_async(monkeypatch):
    enable(monkeypatch)
    mock("Likely a worn spindle bearing; schedule bearing replacement.")
    s = Simulator(seed=1)
    a = Agent(s)
    s.inject_fault("CNC-01", "SPINDLE-VIB")
    a.on_inject("CNC-01")
    pre = "Qualcomm Cloud AI 100: "
    deadline = time.time() + 3
    while time.time() < deadline and not any(e["message"].startswith(pre) for e in a.get_events(200)):
        time.sleep(0.05)
    rc = [e for e in a.get_events(200) if e["message"].startswith(pre)]
    assert rc and rc[-1]["kind"] == "diagnose"
    ids = [e["id"] for e in a.get_events(200)]
    assert ids == sorted(ids)


def test_root_cause_failure_emits_nothing_and_does_not_block(monkeypatch):
    enable(monkeypatch)
    mock(status=500)
    s = Simulator(seed=1)
    a = Agent(s)
    t0 = time.perf_counter()
    s.inject_fault("CNC-01", "SPINDLE-VIB")
    a.on_inject("CNC-01")
    assert time.perf_counter() - t0 < 1.0
    time.sleep(0.3)
    assert not any(e["message"].startswith("Qualcomm") for e in a.get_events(200))


def test_no_key_means_no_network():
    assert llm.providers() == [] and llm.chat("s", []) is None
