import math
import random
from pathlib import Path

import pytest

from app import control as C
from app.simulator import FAULTS, Simulator

POLICY = dict(C.DEFAULT_POLICY)


def machine(code="BRG-OVERHEAT", ttf=18, cost=3000, name="Coolant Pump"):
    return {"id": "PUMP-03", "name": name, "fault": {"code": code}, "predicted_failure_min": ttf,
            "downtime_cost_per_hour": cost, "control": {"setpoints": dict(C.NOMINAL)}}


def test_catalogue_covers_all_five_faults_within_default_envelope():
    assert set(C.CATALOGUE) == set(FAULTS)
    for code, options in C.CATALOGUE.items():
        assert len(options) >= 2  # a gentle and a strong variant, so escalation has somewhere to go
        rates = [m.rate for m in options]
        assert rates == sorted(rates, reverse=True) and all(0 < r < 1 for r in rates)
        for m in options:
            assert C.within_envelope(m.setpoints, POLICY), (code, m.setpoints)
    assert C.controlled_stop("x").rate == 0 and C.is_stop(C.controlled_stop("x").setpoints)


def test_envelope_never_violated_for_random_inputs():
    rng = random.Random(1234)
    junk = [float("nan"), float("inf"), -float("inf"), -50, 0, 1e9, 250, True, None, "x"]
    for _ in range(2000):
        policy = {"autonomy": "auto", "enabled": True, "max_derate_pct": rng.choice([0, 10, 25, 40, 60]),
                  "allow_controlled_stop": rng.random() < 0.5}
        sp = {k: (rng.choice(junk) if rng.random() < 0.2 else rng.uniform(-30, 160))
              for k in ("speed_pct", "load_pct", "coolant_pct")}
        out = C.clamp_setpoints(sp, policy)
        assert C.within_envelope(out, policy), (policy, sp, out)
        lo = 100 - policy["max_derate_pct"]
        if not C.is_stop(out):
            assert lo <= out["speed_pct"] <= 100 and lo <= out["load_pct"] <= 100
        # raw junk is rejected by the checker, never accepted
        if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in sp.values()):
            assert not C.within_envelope(sp, policy)


def test_decide_only_returns_setpoints_inside_the_envelope_for_random_machines():
    rng = random.Random(99)
    for _ in range(1500):
        policy = {"autonomy": "auto", "enabled": True, "max_derate_pct": rng.choice([0, 15, 30, 40, 60]),
                  "allow_controlled_stop": rng.random() < 0.7}
        m = machine(rng.choice(list(FAULTS)), ttf=rng.choice([None, 0, 1, 3, 10, 18, 40, 90, 400]),
                    cost=rng.choice([1000, 4000, 15000]))
        d = C.decide(m, rng.uniform(1, 120), policy)
        if d is None:
            continue
        assert C.within_envelope(d["setpoints"], policy), (policy, d)
        assert 0.0 <= d["rate"] < 1.0
        assert d["expected_loss_avoided_usd"] > 0 and d["throughput_cost_usd_per_hour"] >= 0
        if C.is_stop(d["setpoints"]):
            assert policy["allow_controlled_stop"]
        else:
            lo = 100 - policy["max_derate_pct"]
            assert d["setpoints"]["speed_pct"] >= lo and d["setpoints"]["load_pct"] >= lo


def test_no_action_when_the_machine_survives_until_the_repair():
    assert C.decide(machine(ttf=100), 40, POLICY) is None      # 100 > 1.5 * 40
    assert C.decide(machine(ttf=None), 40, POLICY) is None
    assert C.decide({**machine(), "fault": None}, 40, POLICY) is None
    assert C.decide(machine(), 40, {**POLICY, "enabled": False}) is None


def test_pump_example_matches_the_design():
    d = C.decide(machine(ttf=18), 40, POLICY)
    assert d["kinds"] == ["derate_speed", "boost_cooling"]
    assert d["setpoints"] == {"speed_pct": 70, "load_pct": 100, "coolant_pct": 100}
    assert d["label"] == "Derate pump to 70% + coolant 100%"
    assert d["ttf_before"] == 18 and round(d["ttf_after"]) == 60
    assert d["throughput_cost_usd_per_hour"] == 900
    assert 9000 < d["expected_loss_avoided_usd"] < 12000


def test_a_gentle_action_wins_when_it_is_enough():
    d = C.decide(machine(ttf=30), 25, POLICY)
    assert d["setpoints"]["speed_pct"] == 85  # light derate is cheaper than the strong one


def test_controlled_stop_when_nothing_else_works():
    d = C.decide(machine(ttf=3), 40, POLICY)
    assert d["kinds"] == ["controlled_stop"] and C.is_stop(d["setpoints"])
    assert d["ttf_after"] is None and d["expected_loss_avoided_usd"] > 0
    no_stop = C.decide(machine(ttf=3), 40, {**POLICY, "allow_controlled_stop": False})
    assert no_stop is None or not C.is_stop(no_stop["setpoints"])


def test_tight_envelope_excludes_strong_variants():
    d = C.decide(machine(ttf=18), 40, {**POLICY, "max_derate_pct": 15, "allow_controlled_stop": False})
    assert d is None or d["setpoints"]["speed_pct"] >= 85


def test_policy_validation():
    assert C.validate_policy({"autonomy": "auto"}, POLICY)["autonomy"] == "auto"
    for bad in ({"autonomy": "yolo"}, {"max_derate_pct": 61}, {"max_derate_pct": -1}, {"enabled": "yes"}, {"nope": 1},
                {"max_derate_pct": True}):
        with pytest.raises(ValueError):
            C.validate_policy(bad, POLICY)


def test_simulated_adapter_changes_the_machine():
    plain, derated = Simulator(seed=1), Simulator(seed=1)
    for s in (plain, derated):
        s.inject_fault("PUMP-03", "BRG-OVERHEAT")
    sp = {"speed_pct": 70, "load_pct": 100, "coolant_pct": 100}
    ack = C.SimulatedAdapter(derated).write_setpoints("PUMP-03", sp, rate=0.3, mode="mitigated", action_id="CA-1")
    assert ack["ok"] and ack["readback"] == sp
    for _ in range(60):
        plain.tick()
        derated.tick()
    a, b = plain.get("PUMP-03"), derated.get("PUMP-03")
    assert b["control"] == {"mode": "mitigated", "setpoints": sp, "action_id": "CA-1"}
    assert 22 - b["health"] < 22 - a["health"]                     # health falls slower under the action
    assert b["sensors"]["rpm"] < a["sensors"]["rpm"] * 0.8         # rpm follows speed_pct
    assert b["sensors"]["temperature_c"] < a["sensors"]["temperature_c"]
    assert b["predicted_failure_min"] > a["predicted_failure_min"]
    assert derated.nominal_loss_per_min("PUMP-03") > 0


def test_opcua_adapter_is_only_a_documented_stub():
    with pytest.raises(NotImplementedError):
        C.OpcUaAdapter().write_setpoints("PUMP-03", C.NOMINAL)
    assert "IEC 62443" in C.OpcUaAdapter.__doc__ and "READ BACK" in C.OpcUaAdapter.__doc__


def test_the_control_engine_has_no_llm_dependency():
    """Structural guard: setpoints come from control.py, which must never import or call the LLM."""
    src = Path(C.__file__).read_text(encoding="utf-8")
    assert "import llm" not in src and "from . import llm" not in src and "llm.chat" not in src
    assert not hasattr(C, "llm")
