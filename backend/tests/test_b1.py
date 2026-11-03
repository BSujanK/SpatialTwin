import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import agent, app, sim
from app.simulator import FAULTS, Simulator

MOCK = Path(__file__).resolve().parents[2] / "shared" / "mock" / "machines.json"


def test_initial_state_matches_mock():
    assert Simulator(seed=1).snapshot() == json.loads(MOCK.read_text())


def test_status_follows_health_and_floor():
    s = Simulator(seed=1, speed=500)
    for _ in range(300):
        s.tick()
    for m in s.snapshot():
        assert m["health"] >= 5
        want = "ok" if m["health"] >= 75 else "warning" if m["health"] >= 45 else "fault"
        assert m["status"] == want
    assert s.get("PUMP-03")["health"] < 22


def test_inject_all_codes():
    s = Simulator(seed=1)
    for code in FAULTS:
        m = s.inject_fault("CNC-01", code)
        assert m["fault"]["code"] == code and m["status"] != "ok"
        assert m["predicted_failure_min"] > 0
        s.resolve("CNC-01")
    assert s.get("CNC-01")["status"] == "ok" and s.get("CNC-01")["health"] == 95


def test_prediction_from_trend():
    s = Simulator(seed=1)
    for _ in range(20):
        s.tick()
    assert 10 <= s.get("PUMP-03")["predicted_failure_min"] <= 25


def test_endpoints():
    sim.reset(); agent.reset()
    c = TestClient(app)
    assert c.get("/api/health").json() == {"ok": True}
    assert len(c.get("/api/machines").json()) == 5
    assert c.get("/api/machines/PUMP-03").json()["fault"]["code"] == "BRG-OVERHEAT"
    assert c.get("/api/machines/NOPE").status_code == 404
    r = c.post("/api/demo/inject-fault", json={"machine_id": "PRESS-05", "code": "HYD-LEAK"})
    assert r.status_code == 200 and r.json()["fault"]["part"] == "hydraulic_line"
    assert c.post("/api/demo/inject-fault", json={"machine_id": "X", "code": "HYD-LEAK"}).status_code == 404
    assert c.post("/api/demo/inject-fault", json={"machine_id": "CNC-01", "code": "X"}).status_code == 400
    sim.reset(); agent.reset()


def test_websocket_telemetry():
    sim.reset(); agent.reset()
    c = TestClient(app)
    with c.websocket_connect("/ws/telemetry") as ws:
        msg = ws.receive_json()
    assert msg["type"] == "telemetry" and len(msg["machines"]) == 5 and "kpis" in msg
