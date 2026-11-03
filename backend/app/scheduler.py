"""Quantum-inspired repair scheduler.

Repair ordering for two parallel technicians is written as a QUBO and solved with
seeded simulated annealing (numpy). The objective is expected USD downtime loss:

    loss(m) = downtime_cost_per_hour(m) * (wait_min + est_repair_min) / 60 * failure_risk(m)

Binary variable x[m, s] = 1 when machine m takes slot s. A slot is (technician t,
position k); wait_min is the sum of repair times at earlier positions of the same
technician, which makes the objective quadratic in x:

    E(x) = sum_m,s w_m * r_m * x[m,s]                              (own repair time)
         + sum_m,s,m',s' (s' earlier than s, same tech) w_m * r_m' * x[m,s] * x[m',s']   (waiting)
         + P * sum_m (sum_s x[m,s] - 1)^2                          (one slot per machine)
         + P * sum_s sum_{m<m'} x[m,s] * x[m',s]                   (at most one machine per slot)

with w_m = downtime_cost_per_hour * failure_risk / 60. The same Q matrix could be sent to a
quantum annealer unchanged; here it is solved classically (hence "quantum-inspired").
"""
from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Optional

import numpy as np

TECHS = ["Tech A", "Tech B"]
REPAIR_MIN = {  # estimated repair minutes per fault code
    "BRG-OVERHEAT": 35, "BELT-SLIP": 15, "HYD-LEAK": 25, "SPINDLE-VIB": 30, "JOINT-STALL": 30,
}
DEFAULT_REPAIR_MIN = 30


def repair_minutes(machine: dict) -> int:
    f = machine.get("fault")
    return REPAIR_MIN.get(f["code"], DEFAULT_REPAIR_MIN) if f else DEFAULT_REPAIR_MIN


def failure_risk(machine: dict) -> float:
    """0.25..1.0, higher when predicted failure is near or health is low."""
    pf = machine.get("predicted_failure_min")
    pf = 120.0 if pf is None else float(pf)
    risk = 0.25 + 0.75 * math.exp(-pf / 45.0)
    risk *= 1.0 + (100.0 - machine["health"]) / 400.0
    return min(1.2, risk)


def loss_weight(machine: dict) -> float:
    """USD per minute of delay (expected)."""
    return machine["downtime_cost_per_hour"] / 60.0 * failure_risk(machine)


def schedule_cost(assign: list[list[int]], r: list[float], w: list[float]) -> float:
    """Expected USD loss; assign[t] is the ordered list of machine indices for technician t."""
    total = 0.0
    for queue in assign:
        t = 0.0
        for i in queue:
            t += r[i]
            total += w[i] * t
    return total


def greedy_assignment(machines: list[dict], r: list[float], n_tech: int = 2) -> list[list[int]]:
    """Naive baseline: sort by health (worst first); each job goes to whichever tech is free first."""
    order = sorted(range(len(machines)), key=lambda i: machines[i]["health"])
    free = [0.0] * n_tech
    assign: list[list[int]] = [[] for _ in range(n_tech)]
    for i in order:
        t = min(range(n_tech), key=lambda k: free[k])
        assign[t].append(i)
        free[t] += r[i]
    return assign


def build_qubo(r: list[float], w: list[float], n_tech: int = 2, penalty: Optional[float] = None):
    """Return (Q upper-triangular, slot list, var index fn, penalty)."""
    n = len(r)
    slots = [(t, k) for t in range(n_tech) for k in range(n)]
    S = len(slots)
    nv = n * S
    var = lambda m, s: m * S + s  # noqa: E731
    if penalty is None:
        penalty = 2.0 * max(w) * sum(r) + 1.0
    Q = np.zeros((nv, nv))
    for m in range(n):
        for s, (t, k) in enumerate(slots):
            Q[var(m, s), var(m, s)] += w[m] * r[m] - penalty  # own time; -P from (sum x - 1)^2
            for s2, (t2, k2) in enumerate(slots):
                if t2 == t and k2 < k:  # machines at earlier slots on the same technician delay m
                    for m2 in range(n):
                        if m2 != m:
                            Q[var(m2, s2), var(m, s)] += w[m] * r[m2]
    for m in range(n):  # one slot per machine: pairwise term 2P
        for s in range(S):
            for s2 in range(s + 1, S):
                Q[var(m, s), var(m, s2)] += 2 * penalty
    for s in range(S):  # at most one machine per slot
        for m in range(n):
            for m2 in range(m + 1, n):
                Q[var(m, s), var(m2, s)] += penalty
    return Q, slots, var, penalty


def _decode(x: np.ndarray, n: int, slots) -> Optional[list[list[int]]]:
    """Feasible x -> per-technician ordered queues, else None."""
    S = len(slots)
    X = x.reshape(n, S)
    if not (X.sum(axis=1) == 1).all() or (X.sum(axis=0) > 1).any():
        return None
    per_tech: list[list[tuple[int, int]]] = [[] for _ in TECHS]
    for m in range(n):
        t, k = slots[int(X[m].argmax())]
        per_tech[t].append((k, m))
    return [[m for _, m in sorted(q)] for q in per_tech]


def _encode(assign: list[list[int]], n: int, slots, var) -> np.ndarray:
    x = np.zeros(n * len(slots), dtype=np.int8)
    idx = {sl: s for s, sl in enumerate(slots)}
    for t, q in enumerate(assign):
        for k, m in enumerate(q):
            x[var(m, idx[(t, k)])] = 1
    return x


def anneal(Q: np.ndarray, x0_list: list[np.ndarray], n: int, slots, var, seed: int,
           iters: int = 2500, t_hi: float = 0.0, t_lo: float = 0.0):
    """Simulated annealing on E(x)=x^T Q x. Moves: single flip, reassign machine, swap machines.
    Returns best feasible (x, energy) found, or (None, inf)."""
    rng = np.random.default_rng(seed)
    S = len(slots)
    nv = n * S
    Sym = Q + Q.T
    diag = np.diag(Q).copy()
    off = Sym - np.diag(np.diag(Sym))
    best_x, best_e = None, math.inf

    for x0 in x0_list:
        x = x0.astype(np.int8).copy()
        h = diag + off @ x  # local field
        e = float(x @ Q @ x)
        for it in range(iters):
            temp = t_hi * (t_lo / t_hi) ** (it / iters)
            r = rng.random()
            if r < 0.2:
                flips = [int(rng.integers(nv))]
            else:
                m = int(rng.integers(n))
                cur = np.flatnonzero(x[m * S:(m + 1) * S])
                if len(cur) != 1:
                    flips = [int(rng.integers(nv))]
                else:
                    s_old = int(cur[0])
                    s_new = int(rng.integers(S))
                    if s_new == s_old:
                        continue
                    flips = [var(m, s_old), var(m, s_new)]
                    occ = np.flatnonzero(x[[var(mm, s_new) for mm in range(n)]])
                    if len(occ):  # swap with the machine currently in the target slot
                        m2 = int(occ[0])
                        flips += [var(m2, s_new), var(m2, s_old)]
            d = np.array([1 - 2 * int(x[i]) for i in flips])
            delta = float(d @ h[flips])
            for a in range(len(flips)):
                for b in range(a + 1, len(flips)):
                    delta += d[a] * d[b] * Sym[flips[a], flips[b]]
            if delta <= 0 or rng.random() < math.exp(-delta / temp):
                for i, di in zip(flips, d):
                    h += off[:, i] * di
                    x[i] += di
                e += delta
                if e < best_e - 1e-9 and _decode(x, n, slots) is not None:
                    best_e, best_x = e, x.copy()
    return best_x, best_e


def _reason(m: dict, rank: int, wait: float) -> str:
    f = m.get("fault")
    bits = []
    if m["criticality"] >= 5:
        bits.append(f"critical line machine ({m['criticality']}/5)")
    elif m["criticality"] >= 4:
        bits.append(f"high criticality ({m['criticality']}/5)")
    pf = m.get("predicted_failure_min")
    if pf is not None and pf <= 60:
        bits.append(f"predicted to fail in ~{pf} min")
    bits.append(f"${m['downtime_cost_per_hour']:,}/h downtime")
    if m["status"] == "fault":
        bits.append(f"health {int(round(m['health']))}")
    head = f"{f['code']}: " if f else ""
    tail = "fix first" if rank == 1 else f"starts after ~{int(wait)} min wait" if wait else "runs in parallel"
    return head + ", ".join(bits) + f" ({tail})."


last_solve_ms = 0.0  # wall time of the latest solve (not part of the API payload)


def compute_schedule(machines: list[dict], seed: int = 42, iters: int = 2500, restarts: int = 3) -> dict:
    global last_solve_ms
    t0 = time.perf_counter()
    try:
        return _compute(machines, seed, iters, restarts)
    finally:
        last_solve_ms = round((time.perf_counter() - t0) * 1000, 1)


def _compute(machines: list[dict], seed: int, iters: int, restarts: int) -> dict:
    bad = [m for m in machines if m["status"] != "ok"]
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    base = {"generated_at": now, "method": "qubo-simulated-annealing"}
    if not bad:
        return {**base, "energy": 0.0, "baseline_cost": 0.0, "optimized_cost": 0.0,
                "savings_usd": 0.0, "queue": []}
    n = len(bad)
    r = [float(repair_minutes(m)) for m in bad]
    w = [loss_weight(m) for m in bad]
    greedy = greedy_assignment(bad, r)
    baseline = schedule_cost(greedy, r, w)

    Q, slots, var, penalty = build_qubo(r, w)
    rng = np.random.default_rng(seed)
    starts = [_encode(greedy, n, slots, var)]
    for _ in range(restarts - 1):  # random feasible starts
        perm = rng.permutation(n)
        a: list[list[int]] = [[] for _ in TECHS]
        for j, i in enumerate(perm):
            a[j % len(TECHS)].append(int(i))
        starts.append(_encode(a, n, slots, var))
    # Temperature scaled to the typical cost of one move (USD), not to the penalty.
    scale = max(w) * sum(r) / n
    best_x, best_e = anneal(Q, starts, n, slots, var, seed, iters, t_hi=scale * 0.5, t_lo=scale * 0.005)

    assign = _decode(best_x, n, slots) if best_x is not None else None
    cost = schedule_cost(assign, r, w) if assign else math.inf
    if assign is None or cost > baseline:  # never report worse than the baseline
        assign, cost = greedy, baseline
        best_e = baseline - penalty * n

    placed = []  # (start_min, tech_idx, machine_idx, wait)
    for t, q in enumerate(assign):
        clock = 0.0
        for i in q:
            placed.append((clock, t, i, clock))
            clock += r[i]
    placed.sort()
    wmax = max(w)
    queue = []
    for rank, (_, t, i, wait) in enumerate(placed, start=1):
        queue.append({
            "rank": rank,
            "machine_id": bad[i]["id"],
            "priority_score": round(min(1.0, w[i] / wmax), 2),
            "reason": _reason(bad[i], rank, wait),
            "est_repair_min": int(r[i]),
            "technician": TECHS[t],
        })
    return {**base, "energy": round(best_e, 2), "baseline_cost": round(baseline, 2),
            "optimized_cost": round(cost, 2), "savings_usd": round(baseline - cost, 2),
            "queue": queue}
