import httpx
import pytest

from app import copilot, llm
from app.simulator import FAULTS, Simulator

U = [{"role": "user", "content": "q"}]


def test_inject_jumps_sensors_to_fault_signature():
    def injected(mid, code):
        s = Simulator(seed=1)
        before = s.get(mid)["sensors"]
        m = s.inject_fault(mid, code)
        assert s.get(mid)["sensors"] == m["sensors"]  # visible immediately, no tick needed
        return before, m["sensors"]

    b, a = injected("CNC-01", "SPINDLE-VIB")
    assert 9.0 <= a["vibration_mm_s"] <= 12.0 and a["temperature_c"] >= b["temperature_c"] + 14
    b, a = injected("CNC-01", "BRG-OVERHEAT")
    assert a["temperature_c"] >= 90 and a["vibration_mm_s"] >= 10
    b, a = injected("CNC-01", "HYD-LEAK")
    assert a["pressure_bar"] < b["pressure_bar"] and a["temperature_c"] > b["temperature_c"]
    b, a = injected("CNC-01", "BELT-SLIP")
    assert a["rpm"] < b["rpm"] and a["vibration_mm_s"] >= b["vibration_mm_s"]
    b, a = injected("ROBOT-04", "JOINT-STALL")
    assert a["temperature_c"] >= b["temperature_c"] + 14 and a["rpm"] == 0


def test_every_code_has_a_signature_and_reinjection_does_not_compound():
    assert all("signature" in spec for spec in FAULTS.values())
    s = Simulator(seed=1)
    first = s.inject_fault("CNC-01", "SPINDLE-VIB")["sensors"]["temperature_c"]
    second = s.inject_fault("CNC-01", "SPINDLE-VIB")["sensors"]["temperature_c"]
    assert abs(second - first) < 3.5  # same healthy baseline, only the random part differs


def test_signature_persists_through_ticks_and_resolve_restores():
    s = Simulator(seed=1)
    s.inject_fault("CNC-01", "SPINDLE-VIB")
    for _ in range(5):
        s.tick()
    assert s.get("CNC-01")["sensors"]["vibration_mm_s"] > 8
    s.resolve("CNC-01")
    assert s.get("CNC-01")["sensors"]["vibration_mm_s"] < 3


def _enable(monkeypatch):
    monkeypatch.setenv("QUALCOMM_API_KEY", "k")
    monkeypatch.setenv("QUALCOMM_ENDPOINT", "https://qc.example/v2")


def test_copilot_budget_is_six_seconds_and_applied_to_requests(monkeypatch):
    assert llm.COPILOT_BUDGET_S == 6.0
    seen = {}
    monkeypatch.setattr(llm, "chat", lambda *a, **k: seen.update(k))
    copilot.llm_reply("start", {"name": "n", "id": "i", "status": "fault", "health": 1, "sensors": {
        "temperature_c": 1, "vibration_mm_s": 1, "pressure_bar": 1, "rpm": 1}, "fault": {"code": "X", "description": "d"}},
        {"index": 0, "title": "t", "instruction": "i", "part": "panel", "safety_warning": None}, 5, "start", [])
    assert seen["budget"] == 6.0


def test_per_request_timeout_is_capped_by_the_budget(monkeypatch):
    _enable(monkeypatch)
    timeouts = []

    def handler(req):
        timeouts.append(req.extensions["timeout"]["read"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}}]})

    llm.set_transport(httpx.MockTransport(handler))
    assert llm.chat("s", U, budget=6.0)[0] == "hi"
    assert 0 < timeouts[0] <= 6.0
    assert llm.chat("s", U)[0] == "hi" and timeouts[1] == llm.TIMEOUT_S  # background/default keeps 8 s


def test_retry_only_when_the_budget_allows(monkeypatch):
    _enable(monkeypatch)
    calls = []

    def flaky(req):
        calls.append(1)
        return httpx.Response(503, json={}) if len(calls) == 1 else httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    llm.set_transport(httpx.MockTransport(flaky))
    assert llm.chat("s", U, budget=6.0)[0] == "ok" and len(calls) == 2  # time for a retry
    calls.clear()
    llm.reset_state()
    assert llm.chat("s", U, budget=1.0) is None and len(calls) == 1  # too little time left: no retry


def test_exhausted_budget_means_no_call_and_scripted_reply(monkeypatch):
    _enable(monkeypatch)
    calls = []
    llm.set_transport(httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(200, json={})))
    assert llm.chat("s", U, budget=0.0) is None and not calls
