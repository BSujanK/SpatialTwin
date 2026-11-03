import time

from fastapi.testclient import TestClient

from app.agent import Agent
from app.main import agent as g_agent, app, sim as g_sim
from app.simulator import Simulator


def kinds(agent):
    return [e["kind"] for e in agent.get_events(100)]


def test_startup_registers_existing_faults():
    a = Agent(Simulator(seed=1))
    ev = a.get_events()
    assert [e["kind"] for e in ev].count("detect") == 3
    assert "schedule" in kinds(a) and "dispatch" not in kinds(a)
    assert a.kpis()["active_faults"] == 3 and a.kpis()["at_risk_usd_per_hour"] == 30000


def test_inject_runs_loop_fast():
    s = Simulator(seed=1)
    a = Agent(s)
    n0 = len(a.get_events(100))
    t0 = time.perf_counter()
    s.inject_fault("CNC-01", "SPINDLE-VIB")
    a.on_inject("CNC-01")
    assert time.perf_counter() - t0 < 1.0
    new = a.get_events(100)[n0:]
    assert [e["kind"] for e in new if e["kind"] != "mitigate"][:4] == ["detect", "diagnose", "schedule", "dispatch"]  # v1.3 may add a mitigate event after diagnose
    assert [e["id"] for e in a.get_events(100)] == sorted(e["id"] for e in a.get_events(100))
    k = a.kpis()
    assert k["active_faults"] == 4 and k["at_risk_usd_per_hour"] == 34000
    assert {t["status"] for t in k["technicians"]} == {"en_route"}
    assert k["downtime_cost_avoided_usd"] > 0


def test_guide_resolve_and_next_dispatch():
    s = Simulator(seed=1)
    a = Agent(s)
    a.on_inject("PRESS-05")
    tech = next(t for t in a.kpis()["technicians"] if t["machine_id"] == "PRESS-05")
    a.on_guide("PRESS-05")
    assert next(t for t in a.kpis()["technicians"] if t["name"] == tech["name"])["status"] == "repairing"
    a.on_resolve("PRESS-05")
    k = a.kpis()
    assert s.get("PRESS-05")["status"] == "ok" and s.get("PRESS-05")["health"] == 95
    assert k["repairs_completed"] == 1 and k["avg_mttr_min"] is not None
    assert kinds(a).count("guide") == 1 and "resolve" in kinds(a)
    # freed technician is dispatched to the next queued job
    assert next(t for t in k["technicians"] if t["name"] == tech["name"])["status"] == "en_route"


def test_worsening_status_triggers_detect():
    s = Simulator(seed=1)
    a = Agent(s)
    n0 = len(a.get_events(100))
    a.on_tick([("CONV-02", "warning", "fault")])
    assert [e["kind"] for e in a.get_events(100)[n0:]][:2] == ["detect", "diagnose"]
    n1 = len(a.get_events(100))
    a.on_tick([("CONV-02", "fault", "warning")])  # improving: ignored
    assert len(a.get_events(100)) == n1


def test_endpoints_and_websocket_events():
    g_sim.reset(); g_agent.reset()
    c = TestClient(app)
    with c.websocket_connect("/ws/telemetry") as ws:
        assert ws.receive_json()["type"] == "telemetry"
        c.post("/api/demo/inject-fault", json={"machine_id": "CNC-01", "code": "SPINDLE-VIB"})
        got = []
        for _ in range(12):
            msg = ws.receive_json()
            if msg["type"] == "event":
                got.append(msg["event"]["kind"])
            if "dispatch" in got:
                break
    assert [k for k in got if k != "mitigate"][:4] == ["detect", "diagnose", "schedule", "dispatch"]  # mitigate (v1.3) sits between diagnose and schedule
    ev = c.get("/api/events?limit=5").json()
    assert len(ev) == 5 and set(ev[0]) == {"id", "ts", "kind", "machine_id", "message"}
    k = c.get("/api/kpis").json()
    assert k["active_faults"] == 4
    assert set(k) == {"active_faults", "at_risk_usd_per_hour", "repairs_completed", "avg_mttr_min",
                      "downtime_cost_avoided_usd", "technicians", "mitigations_active", "failures_prevented",
                      "ttf_extended_min", "throughput_cost_usd_per_hour"}
    g_sim.reset(); g_agent.reset()
