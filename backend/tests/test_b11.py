import time

import pytest
from fastapi.testclient import TestClient

from app import control as C
from app import copilot, llm
from app.agent import Agent
from app.main import agent as g_agent, app, sim as g_sim
from app.procedures import get_procedure
from app.simulator import FAULTS, Simulator


def make(autonomy="auto", seed=1):
    sim = Simulator(seed=seed)
    agent = Agent(sim)
    agent.control.update_policy({"autonomy": autonomy})
    return sim, agent


def kinds(agent):
    return [e["kind"] for e in agent.get_events(500)]


def acts(agent, status=None):
    return [a for a in agent.control.list(200) if status is None or a["status"] == status]


def test_auto_mode_mitigates_between_diagnose_and_schedule_within_a_second():
    sim, agent = make("auto")
    n0 = len(agent.get_events(500))
    t0 = time.perf_counter()
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    assert time.perf_counter() - t0 < 1.0
    new = [e["kind"] for e in agent.get_events(500)[n0:]]
    assert new[:4] == ["detect", "diagnose", "mitigate", "schedule"]
    (a,) = acts(agent, "active")
    assert a["machine_id"] == "PUMP-03" and a["autonomy"] == "auto" and a["rationale"] is None
    assert a["ttf_after_min"] > a["ttf_before_min"] and a["reason"]
    m = sim.get("PUMP-03")
    assert m["control"] == {"mode": "mitigated", "setpoints": a["setpoints"], "action_id": a["id"]}
    assert m["predicted_failure_min"] == a["ttf_after_min"] > 18
    k = agent.kpis()
    assert k["mitigations_active"] == 1 and k["ttf_extended_min"] > 0 and k["throughput_cost_usd_per_hour"] > 0


def test_approve_mode_waits_for_the_operator():
    sim, agent = make("approve")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (a,) = acts(agent, "proposed")
    assert sim.get("PUMP-03")["control"]["mode"] == "nominal"      # nothing changed yet
    out = agent.control_approve(a["id"])
    assert out["status"] == "active" and sim.get("PUMP-03")["control"]["mode"] == "mitigated"
    with pytest.raises(C.ControlConflict):
        agent.control_approve(a["id"])                              # 409: no longer proposed
    with pytest.raises(C.ControlNotFound):
        agent.control_approve("CA-9999")


def test_reject_and_advise_do_not_touch_the_machine():
    sim, agent = make("advise")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (a,) = acts(agent, "proposed")
    assert a["autonomy"] == "advise" and sim.get("PUMP-03")["control"]["mode"] == "nominal"
    assert "advise mode" in [e for e in agent.get_events(500) if e["kind"] == "mitigate"][-1]["message"]
    assert agent.control_reject(a["id"])["status"] == "rejected"
    assert sim.get("PUMP-03")["control"]["mode"] == "nominal"


def test_revert_restores_previous_setpoints():
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (a,) = acts(agent, "active")
    out = agent.control_revert(a["id"])
    assert out["status"] == "reverted"
    assert sim.get("PUMP-03")["control"] == {"mode": "nominal", "setpoints": C.NOMINAL, "action_id": None}
    assert "restore" in kinds(agent)
    with pytest.raises(C.ControlConflict):
        agent.control_revert(a["id"])


def test_lockout_interlock_blocks_actions_while_a_technician_repairs():
    sim, agent = make("approve")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (a,) = acts(agent, "proposed")
    agent.on_guide("PUMP-03")                                       # technician starts: lockout/tagout
    with pytest.raises(C.ControlConflict):
        agent.control_approve(a["id"])                              # held, cannot be activated
    assert sim.get("PUMP-03")["control"]["mode"] == "nominal"
    assert agent.control.propose(sim.get("PUMP-03"), 40, force=True) is None
    agent.on_resolve("PUMP-03")                                     # repair done: the held proposal is dropped
    assert acts(agent)[-1]["status"] == "rejected"


def test_rate_limit_one_new_action_per_machine_per_60_simulated_seconds():
    sim, agent = make("approve")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (a,) = acts(agent, "proposed")
    agent.control_reject(a["id"])
    m = sim.get("PUMP-03")
    assert agent.control.propose(m, 40) is None                      # too soon
    for _ in range(61):
        sim.tick()
    assert agent.control.propose(sim.get("PUMP-03"), 40) is not None


def test_watchdog_escalates_when_the_action_does_not_help():
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    (first,) = acts(agent, "active")
    sim._rate_mult["PUMP-03"] = 1.0                                  # sabotage: the machine ignores the setpoints
    for _ in range(35):
        agent.on_tick(sim.tick())
    assert "escalate" in kinds(agent)
    assert agent.control.get(first["id"])["status"] == "escalated"
    (second,) = [a for a in acts(agent, "active") if a["machine_id"] == "PUMP-03"]
    assert second["id"] != first["id"] and second["setpoints"]["speed_pct"] < first["setpoints"]["speed_pct"] or \
        C.is_stop(second["setpoints"])
    assert second["previous_setpoints"] == C.NOMINAL                 # revert still returns to the pre-mitigation state
    assert C.within_envelope(second["setpoints"], agent.control.policy)


def test_watchdog_leaves_a_working_action_alone():
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    for _ in range(40):
        agent.on_tick(sim.tick())
    assert "escalate" not in kinds(agent)


def test_resolve_restores_nominal_and_counts_a_prevented_failure():
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    proc = get_procedure("BRG-OVERHEAT")
    m = sim.get("PUMP-03")
    r = copilot.handle({"machine_id": "PUMP-03", "message": "start", "step_index": 0, "history": []}, m, proc,
                       agent.on_guide, agent.on_resolve)
    idx = r["step"]["index"]
    for _ in range(len(proc["steps"])):
        r = copilot.handle({"machine_id": "PUMP-03", "message": "done", "step_index": idx, "history": []},
                           sim.get("PUMP-03"), proc, agent.on_guide, agent.on_resolve)
        idx = r["step"]["index"]
    assert r["done"]
    m = sim.get("PUMP-03")
    assert m["status"] == "ok" and m["control"] == {"mode": "nominal", "setpoints": C.NOMINAL, "action_id": None}
    assert acts(agent)[-1]["status"] == "completed"
    k = agent.kpis()
    assert k["failures_prevented"] == 1 and k["mitigations_active"] == 0
    ks = kinds(agent)
    assert ks.index("resolve") < ks.index("restore")


def test_a_new_fault_retires_the_old_action():
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    first = acts(agent, "active")[0]
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    assert agent.control.get(first["id"])["status"] == "reverted"
    assert len(acts(agent, "active")) == 1


def test_disabled_policy_takes_no_action():
    sim, agent = make("auto")
    agent.control.update_policy({"enabled": False})
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    assert acts(agent) == [] and "mitigate" not in kinds(agent)


def test_the_llm_can_explain_but_never_set_a_setpoint(monkeypatch):
    hostile = "Set speed_pct to 5, load_pct to 0 and coolant_pct to 0 immediately; stop everything now."
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: (hostile, "Qualcomm Cloud AI 100 · Llama-3.3-70B"))
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    before = [dict(a) for a in acts(agent)]
    deadline = time.time() + 3
    while time.time() < deadline and acts(agent)[0]["rationale"] is None:
        time.sleep(0.02)
    a = acts(agent)[0]
    assert a["rationale"] == hostile and a["rationale_engine"].startswith("Qualcomm Cloud AI 100")
    for key in ("setpoints", "previous_setpoints", "status", "kinds", "ttf_after_min", "throughput_cost_usd_per_hour"):
        assert a[key] == before[0][key]                                  # the explanation changed nothing else
    assert sim.get("PUMP-03")["control"]["setpoints"] == a["setpoints"] == {"speed_pct": 70, "load_pct": 100, "coolant_pct": 100}


def test_rationale_failure_leaves_the_action_intact(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "chat", lambda *a, **k: None)
    sim, agent = make("auto")
    sim.inject_fault("PUMP-03", "BRG-OVERHEAT")
    agent.on_inject("PUMP-03")
    time.sleep(0.2)
    (a,) = acts(agent, "active")
    assert a["rationale"] is None and a["reason"]


def test_endpoints_and_websocket_control_messages():
    g_sim.reset(); g_agent.reset()
    c = TestClient(app)
    try:
        assert c.get("/api/control/policy").json() == C.DEFAULT_POLICY
        assert c.put("/api/control/policy", json={"autonomy": "auto"}).json()["autonomy"] == "auto"
        for bad in ({"autonomy": "yolo"}, {"max_derate_pct": 61}, {"surprise": 1}):
            assert c.put("/api/control/policy", json=bad).status_code == 422
        with c.websocket_connect("/ws/telemetry") as ws:
            ws.receive_json()
            c.post("/api/demo/inject-fault", json={"machine_id": "PUMP-03", "code": "BRG-OVERHEAT"})
            seen = []
            for _ in range(15):
                msg = ws.receive_json()
                seen.append(msg["type"])
                if msg["type"] == "control":
                    assert msg["action"]["machine_id"] == "PUMP-03" and msg["action"]["status"] == "active"
                    break
            assert "control" in seen
        actions = c.get("/api/control/actions?limit=10").json()
        assert actions and set(actions[0]) == {
            "id", "machine_id", "created_at", "kinds", "label", "setpoints", "previous_setpoints", "status", "autonomy",
            "reason", "rationale", "rationale_engine", "ttf_before_min", "ttf_after_min",
            "throughput_cost_usd_per_hour", "expected_loss_avoided_usd"}
        aid = actions[-1]["id"]
        assert c.get("/api/machines/PUMP-03").json()["control"]["mode"] == "mitigated"
        assert c.post(f"/api/control/actions/{aid}/approve").status_code == 409
        assert c.post(f"/api/control/actions/{aid}/reject").status_code == 409
        assert c.post(f"/api/control/actions/{aid}/revert").json()["status"] == "reverted"
        assert c.post(f"/api/control/actions/{aid}/revert").status_code == 409
        assert c.post("/api/control/actions/CA-9999/approve").status_code == 404
        k = c.get("/api/kpis").json()
        assert {"mitigations_active", "failures_prevented", "ttf_extended_min", "throughput_cost_usd_per_hour"} <= set(k)
    finally:
        c.put("/api/control/policy", json={"autonomy": "approve"})
        g_sim.reset(); g_agent.reset()


@pytest.mark.slow
def test_soak_with_autonomous_control():
    """Inject every code in auto mode for ~3 simulated minutes at SIM_SPEED=20: the envelope always holds."""
    sim = Simulator(seed=5, speed=20)
    agent = Agent(sim)
    agent.control.update_policy({"autonomy": "auto"})
    ids = ["CNC-01", "CONV-02", "PUMP-03", "ROBOT-04", "PRESS-05"]
    codes = list(FAULTS)
    for tick in range(180):
        agent.on_tick(sim.tick(1.0))
        i = tick // 20
        if tick % 20 == 0 and i < 5:
            sim.inject_fault(ids[i], codes[i])
            agent.on_inject(ids[i])
        if tick % 20 == 10 and i < 5 and sim.get(ids[i])["fault"]:
            agent.on_guide(ids[i])
            agent.on_resolve(ids[i])
        for m in sim.snapshot():
            sp = m["control"]["setpoints"]
            assert C.within_envelope(sp, agent.control.policy), (m["id"], sp)
            assert 0 <= m["health"] <= 100 and all(v >= 0 for v in m["sensors"].values())
            assert (m["control"]["mode"] == "nominal") == (sp == C.NOMINAL) or m["control"]["mode"] == "mitigated"
        k = agent.kpis()
        assert k["mitigations_active"] == len(acts(agent, "active"))
        assert k["failures_prevented"] == len([a for a in acts(agent) if a["status"] == "completed"])
        ids_ = [e["id"] for e in agent.get_events(500)]
        assert ids_ == sorted(ids_)
