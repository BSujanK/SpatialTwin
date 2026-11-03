import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import copilot
from app.main import agent, app, sim
from app.procedures import PROCEDURES

MOCK = Path(__file__).resolve().parents[2] / "shared" / "mock"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    sim.reset(); agent.reset()
    yield
    sim.reset(); agent.reset()


def call(c, mid, msg, idx, history=None):
    r = c.post("/api/copilot", json={"machine_id": mid, "message": msg, "step_index": idx, "history": history or []})
    assert r.status_code == 200, r.text
    return r.json()


def test_brg_procedure_matches_mock_exactly():
    c = TestClient(app)
    assert c.get("/api/procedures/BRG-OVERHEAT").json() == json.loads((MOCK / "procedure_BRG-OVERHEAT.json").read_text(encoding="utf-8"))
    assert c.get("/api/procedures/NOPE").status_code == 404


def test_all_procedures_valid():
    parts = {"motor", "belt", "valve", "bearing", "panel", "spindle", "arm_joint", "hydraulic_line"}
    assert set(PROCEDURES) == {"BRG-OVERHEAT", "BELT-SLIP", "HYD-LEAK", "SPINDLE-VIB", "JOINT-STALL"}
    for p in PROCEDURES.values():
        assert 4 <= len(p["steps"]) <= 5
        for i, st in enumerate(p["steps"]):
            assert st["index"] == i and st["part"] in parts
            assert set(st) == {"index", "title", "instruction", "part", "safety_warning"}


def test_full_walkthrough_scripted():
    c = TestClient(app)
    r = call(c, "PUMP-03", "start", 0)
    assert r["source"] == "scripted" and r["step"]["index"] == 0 and not r["done"] and r["total_steps"] == 5
    assert r["step"]["safety_warning"] in r["reply"]
    assert any(t["status"] == "repairing" for t in c.get("/api/kpis").json()["technicians"])
    q = call(c, "PUMP-03", "what torque?", 0)  # question: no advance
    assert q["step"]["index"] == 0 and not q["done"]
    idx = 0
    for _ in range(4):
        r = call(c, "PUMP-03", "done", idx)
        idx = r["step"]["index"]
        assert not r["done"]
    assert idx == 4
    last = call(c, "PUMP-03", "next", 4)
    assert last["done"] and last["step"]["index"] == 4
    m = c.get("/api/machines/PUMP-03").json()
    assert m["status"] == "ok" and m["health"] == 95 and m["fault"] is None
    kinds = [e["kind"] for e in c.get("/api/events?limit=50").json()]
    assert "guide" in kinds and kinds[-1] in ("resolve", "schedule", "dispatch")
    assert "resolve" in kinds
    assert c.get("/api/kpis").json()["repairs_completed"] == 1


def test_step_index_clamped_and_errors():
    c = TestClient(app)
    assert call(c, "PUMP-03", "start", 99)["step"]["index"] == 4
    assert c.post("/api/copilot", json={"machine_id": "CNC-01", "message": "start", "step_index": 0, "history": []}).status_code == 400
    assert c.post("/api/copilot", json={"machine_id": "X", "message": "start", "step_index": 0, "history": []}).status_code == 404


class FakeClient:
    last = {}

    def __init__(self, **kw):
        self.messages = self

    def create(self, **kw):
        FakeClient.last = kw
        class B: text = "Torque it to twenty-five newton metres."
        class R: content = [B()]
        return R()


def test_llm_path_and_advance_stays_in_code(monkeypatch):
    import anthropic
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    c = TestClient(app)
    r = call(c, "PUMP-03", "what torque?", 2, [{"role": "assistant", "content": "hi"}, {"role": "user", "content": "x"}])
    assert r["source"] == "llm" and r["step"]["index"] == 2 and not r["done"]
    assert "96." in FakeClient.last["system"] and "BRG-OVERHEAT" in FakeClient.last["system"]
    assert FakeClient.last["max_tokens"] == 200 and FakeClient.last["messages"][0]["role"] == "user"
    # even if the model chatters, "done" advances by code and the safety warning is appended
    r = call(c, "PUMP-03", "done", 0)
    assert r["step"]["index"] == 1 and r["step"]["safety_warning"] in r["reply"]


def test_llm_error_falls_back(monkeypatch):
    import anthropic

    class Boom:
        def __init__(self, **kw):
            raise RuntimeError("down")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(anthropic, "Anthropic", Boom)
    r = call(TestClient(app), "PUMP-03", "start", 0)
    assert r["source"] == "scripted" and r["step"]["index"] == 0


def test_classify():
    assert [copilot.classify(m) for m in ("Start", " done ", "OK!", "what torque?")] == ["start", "advance", "advance", "question"]
