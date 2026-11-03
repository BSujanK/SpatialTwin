import pytest
from fastapi.testclient import TestClient

from app import copilot
from app.agent import Agent
from app.main import agent as g_agent, app, sim as g_sim
from app.procedures import PROCEDURES, get_procedure
from app.simulator import FAULTS, Simulator


def walk(sim, agent, mid):
    """Run the whole guided repair for a machine through the copilot."""
    m = sim.get(mid)
    proc = get_procedure(m["fault"]["code"])
    total = len(proc["steps"])
    r = copilot.handle({"machine_id": mid, "message": "start", "step_index": 0, "history": []},
                       m, proc, agent.on_guide, agent.on_resolve)
    idx = r["step"]["index"]
    for _ in range(total):
        r = copilot.handle({"machine_id": mid, "message": "done", "step_index": idx, "history": []},
                           sim.get(mid) or m, proc, agent.on_guide, agent.on_resolve)
        idx = r["step"]["index"]
    assert r["done"]


def test_guide_reroutes_when_no_tech_free():
    s = Simulator(seed=1)
    a = Agent(s)
    s.inject_fault("CNC-01", "SPINDLE-VIB")
    a.on_inject("CNC-01")
    # both techs are en_route on other jobs; a third machine gets guided
    busy = {t["machine_id"] for t in a.kpis()["technicians"]}
    target = next(m["id"] for m in s.snapshot() if m["status"] != "ok" and m["id"] not in busy)
    n0 = len(a.get_events(200))
    a.on_guide(target)
    new = a.get_events(200)[n0:]
    assert [e["kind"] for e in new] == ["dispatch", "guide"]
    assert new[0]["message"].startswith("Re-routed Tech")
    assert any(t["machine_id"] == target and t["status"] == "repairing" for t in a.kpis()["technicians"])
    a.on_resolve(target)  # MTTR still fires
    assert a.kpis()["avg_mttr_min"] is not None


def test_procedures_list_endpoint():
    c = TestClient(app)
    r = c.get("/api/procedures").json()
    assert {p["fault_code"] for p in r} == set(FAULTS)
    assert all(set(p) == {"fault_code", "title"} for p in r)
    assert c.get("/api/procedures/HYD-LEAK").status_code == 200


def test_reset_pushes_telemetry_and_events():
    g_sim.reset(); g_agent.reset()
    c = TestClient(app)
    c.post("/api/demo/inject-fault", json={"machine_id": "CNC-01", "code": "SPINDLE-VIB"})
    with c.websocket_connect("/ws/telemetry") as ws:
        ws.receive_json()
        assert c.post("/api/demo/reset").json() == {"ok": True}
        types = []
        for _ in range(12):
            msg = ws.receive_json()
            types.append(msg["type"])
            if msg["type"] == "telemetry":
                assert msg["kpis"]["active_faults"] == 3 and msg["kpis"]["repairs_completed"] == 0
        assert "telemetry" in types and "event" in types
    assert len(c.get("/api/events").json()) == len(g_agent.get_events(50))
    g_sim.reset(); g_agent.reset()


@pytest.mark.slow
def test_soak_all_codes_at_speed_20():
    """~3 simulated minutes at SIM_SPEED=20: inject every code, walk every procedure, check invariants."""
    s = Simulator(seed=3, speed=20)
    a = Agent(s)
    ids = ["CNC-01", "CONV-02", "PUMP-03", "ROBOT-04", "PRESS-05"]
    codes = list(FAULTS)
    assert set(codes) == set(PROCEDURES)
    resolved = 0

    def check():
        for m in s.snapshot():
            assert 0 <= m["health"] <= 100
            assert m["status"] == ("ok" if m["health"] >= 75 else "warning" if m["health"] >= 45 else "fault")
        k = a.kpis()
        bad = [m for m in s.snapshot() if m["status"] != "ok"]
        assert k["active_faults"] == len(bad)
        assert k["at_risk_usd_per_hour"] == sum(m["downtime_cost_per_hour"] for m in bad)
        assert k["repairs_completed"] == resolved
        assert k["downtime_cost_avoided_usd"] >= 0
        assert all(t["status"] == "idle" or t["machine_id"] for t in k["technicians"])
        ids_ = [e["id"] for e in a.get_events(500)]
        assert ids_ == sorted(ids_) and len(set(ids_)) == len(ids_)

    for tick in range(180):
        a.on_tick(s.tick(1.0))
        if tick % 20 == 0 and tick // 20 < 5:
            i = tick // 20
            s.inject_fault(ids[i], codes[i])
            a.on_inject(ids[i])
        if tick % 20 == 10 and tick // 20 < 5:
            mid = ids[tick // 20]
            if s.get(mid)["fault"]:
                walk(s, a, mid)
                resolved += 1
        check()
    for m in s.snapshot():  # clear anything still faulted
        if m["fault"]:
            walk(s, a, m["id"])
            resolved += 1
            check()
    assert {m["status"] for m in s.snapshot()} == {"ok"}
    assert a.kpis()["repairs_completed"] == resolved >= 5
