import itertools
import time

import pytest
from fastapi.testclient import TestClient

from app import scheduler as sc
from app.main import agent, app, sim
from app.simulator import Simulator


def _case(seed: int):
    s = Simulator(seed=seed)
    codes = ["SPINDLE-VIB", "JOINT-STALL", "BELT-SLIP", "HYD-LEAK", "BRG-OVERHEAT"]
    ids = ["CNC-01", "ROBOT-04", "CONV-02", "PRESS-05", "PUMP-03"]
    k = [3, 4, 5][seed % 3]
    for mid, code in list(zip(ids, codes))[:k]:
        s.inject_fault(mid, code)
    for _ in range(seed * 5):
        s.tick()
    return s.snapshot()


@pytest.mark.parametrize("seed", [0, 1, 2, 7])
def test_valid_permutation_and_not_worse_than_greedy(seed):
    ms = _case(seed)
    sched = sc.compute_schedule(ms, seed=seed)
    bad = {m["id"] for m in ms if m["status"] != "ok"}
    assert {q["machine_id"] for q in sched["queue"]} == bad
    assert len(sched["queue"]) == len(bad)  # each machine exactly once
    assert [q["rank"] for q in sched["queue"]] == list(range(1, len(bad) + 1))
    assert {q["technician"] for q in sched["queue"]} <= {"Tech A", "Tech B"}
    assert sched["optimized_cost"] <= sched["baseline_cost"]
    assert sched["savings_usd"] == pytest.approx(sched["baseline_cost"] - sched["optimized_cost"], abs=0.02)
    assert sc.last_solve_ms < 300


def test_close_to_brute_force_optimum():
    ms = [m for m in _case(2) if m["status"] != "ok"]
    r = [float(sc.repair_minutes(m)) for m in ms]
    w = [sc.loss_weight(m) for m in ms]
    n = len(ms)
    best = float("inf")
    for perm in itertools.permutations(range(n)):
        for cut in range(n + 1):
            best = min(best, sc.schedule_cost([list(perm[:cut]), list(perm[cut:])], r, w))
    got = sc.compute_schedule(_case(2), seed=2)["optimized_cost"]
    assert got <= best * 1.02


def test_deterministic_with_seed():
    ms = _case(1)
    a, b = sc.compute_schedule(ms, seed=5), sc.compute_schedule(ms, seed=5)
    assert [q["machine_id"] for q in a["queue"]] == [q["machine_id"] for q in b["queue"]]
    assert a["energy"] == b["energy"]


def test_schedule_endpoints_and_auto_recompute():
    sim.reset(); agent.reset()
    c = TestClient(app)
    c.post("/api/schedule/recompute")
    before = c.get("/api/schedule").json()
    assert before["method"] == "qubo-simulated-annealing"
    assert set(before) == {"generated_at", "method", "energy", "baseline_cost", "optimized_cost", "savings_usd", "queue"}
    c.post("/api/demo/inject-fault", json={"machine_id": "CNC-01", "code": "SPINDLE-VIB"})
    after = c.get("/api/schedule").json()
    assert len(after["queue"]) == len(before["queue"]) + 1
    sim.reset(); agent.reset()


def test_empty_when_all_ok():
    ms = Simulator(seed=1).snapshot()
    for m in ms:
        m["status"] = "ok"
    assert sc.compute_schedule(ms)["queue"] == []
