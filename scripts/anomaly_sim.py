"""Monte Carlo of anomaly events through SpatialTwin's own scheduler (QUBO vs greedy)
and control engine (autonomous mitigation). Usage (from the repo root): python scripts/anomaly_sim.py backend 1000"""
import copy, json, random, statistics, sys, time
sys.path.insert(0, sys.argv[1])
from app import scheduler, control
from app.simulator import INITIAL_MACHINES, FAULTS

N = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
rng = random.Random(7)
FAULT_FOR = {"pump": "BRG-OVERHEAT", "conveyor": "BELT-SLIP", "press": "HYD-LEAK", "cnc": "SPINDLE-VIB", "robot_arm": "JOINT-STALL"}
POLICY = {"autonomy": "auto", "enabled": True, "max_derate_pct": 40, "allow_controlled_stop": True}

def scenario():
    ms = copy.deepcopy(INITIAL_MACHINES)
    k = rng.randint(2, 4)                       # 2-4 simultaneous anomalies on the line
    hit = set(rng.sample(range(len(ms)), k))
    for i, m in enumerate(ms):
        if i in hit:
            code = FAULT_FOR[m["type"]]
            f = FAULTS[code]
            m["health"] = rng.uniform(15, 70)
            m["status"] = "fault" if m["health"] < 45 else "warning"
            m["predicted_failure_min"] = int(rng.uniform(10, 120))
            m["fault"] = {"code": code, "description": f["description"], "part": f["part"], "since": "2026-11-03T00:00:00+05:30"}
        else:
            m.update(status="ok", health=rng.uniform(80, 98), fault=None, predicted_failure_min=None)
    return ms

sched_base, sched_opt, mit_avoided, prevented, at_risk, n_mitig, n_faults, solve_ms = [], [], [], 0, 0, 0, 0, []
for _ in range(N):
    ms = scenario()
    t0 = time.perf_counter(); s = scheduler.compute_schedule(ms, seed=rng.randint(0, 10**6)); solve_ms.append((time.perf_counter() - t0) * 1000)
    sched_base.append(s["baseline_cost"]); sched_opt.append(s["optimized_cost"])
    clock = {}
    by_id = {m["id"]: m for m in ms}
    for q in s["queue"]:                        # wait + repair minutes per machine from the optimized plan
        t = q["technician"]; clock[t] = clock.get(t, 0) + q["est_repair_min"]
        m = by_id[q["machine_id"]]; wr = clock[t]; n_faults += 1
        _, p0 = control.expected_loss(m["downtime_cost_per_hour"], m["predicted_failure_min"], wr, 1.0, 0.0)
        if p0 > 0.5: at_risk += 1
        d = control.decide(m, wr, POLICY)
        if d:
            n_mitig += 1; mit_avoided.append(d["expected_loss_avoided_usd"])
            if p0 > 0.5 and d["p_fail"] < 0.5 and d["ttf_after"] is not None: prevented += 1
        else:
            mit_avoided.append(0.0)

tb, to = sum(sched_base), sum(sched_opt)
out = {
    "events": N, "anomalies": n_faults,
    "sched_saving_pct": round(100 * (tb - to) / tb, 1),
    "sched_saving_per_event_usd": round((tb - to) / N),
    "mitigations": n_mitig, "mitigation_rate_pct": round(100 * n_mitig / n_faults, 1),
    "mitigation_avoided_per_event_usd": round(sum(mit_avoided) / N),
    "anomalies_heading_to_failure": at_risk, "failures_prevented_without_stop": prevented,
    "total_avoided_per_event_usd": round((tb - to + sum(mit_avoided)) / N),
    "median_solve_ms": round(statistics.median(solve_ms), 1),
}
print(json.dumps(out, indent=2))
