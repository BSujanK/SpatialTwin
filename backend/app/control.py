"""Autonomous control: deterministic mitigation engine, safety envelope, adapters and action lifecycle.

SAFETY RULE: this module never imports or calls the LLM. Every setpoint is chosen by the catalogue and the
economic decision rule below and is bounded by the safety envelope. The LLM (see agent.py) only writes a
plain-language `rationale` string *about* an action that already exists; it cannot create or change one.

Decision rule (design doc 3.3): for a machine with predicted time to failure T and technician wait+repair W,
  - if T > 1.5 W the machine survives until the repair: no action;
  - else pick argmin expected_loss(a) over {do nothing, catalogue candidates inside the envelope, controlled stop}, with
        T_a = T / rate_a,  p_fail(a) = sigmoid((W - T_a) / 5),
        expected_loss(a) = p_fail(a) * cost_per_hour * 4h + throughput_cost_frac(a) * cost_per_hour * W / 60;
  - if even the best action leaves p_fail > 0.5 and a controlled stop is allowed, stop (a planned stop beats a failure).
"""
from __future__ import annotations

import copy
import math
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

NOMINAL = {"speed_pct": 100, "load_pct": 100, "coolant_pct": 50}
DEFAULT_POLICY = {"autonomy": "approve", "enabled": True, "max_derate_pct": 40, "allow_controlled_stop": True}
AUTONOMY = ("advise", "approve", "auto")
FAILURE_COST_HOURS = 4.0          # an unplanned failure = 4 h outage plus collateral damage
SURVIVES_FACTOR = 1.5             # T > 1.5 W: the machine survives until the repair
WATCHDOG_S = 30.0                 # simulated seconds an action gets to show improvement
WATCHDOG_MIN_IMPROVEMENT = 0.40   # health-loss slope must improve by at least 40%
RATE_LIMIT_S = 60.0               # at most one new action per machine per 60 simulated seconds
MAX_DERATE_LIMIT = 60             # policy can never allow derating beyond 60%


class ControlError(Exception):
    """Base class; HTTP layer maps subclasses to status codes."""


class ControlNotFound(ControlError):
    pass


class ControlConflict(ControlError):
    pass


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- catalogue
@dataclass(frozen=True)
class Mitigation:
    kinds: tuple
    label: str              # format string over speed/load/coolant
    setpoints: dict
    rate: float             # degradation-rate multiplier (0 = health stops falling)
    cost_frac: float        # share of downtime_cost_per_hour lost while active
    effect: str             # one phrase for the deterministic reason


def _sp(speed=100, load=100, coolant=50) -> dict:
    return {"speed_pct": speed, "load_pct": load, "coolant_pct": coolant}


# Ordered gentle -> strong. Escalation moves down this list (lower rate), ending at the controlled stop.
CATALOGUE: dict[str, list[Mitigation]] = {
    "BRG-OVERHEAT": [
        Mitigation(("derate_speed", "boost_cooling"), "Derate pump to {speed_pct}% + coolant {coolant_pct}%",
                   _sp(85, 100, 100), 0.55, 0.15, "a light derate with full cooling reduces bearing heat build-up"),
        Mitigation(("derate_speed", "boost_cooling"), "Derate pump to {speed_pct}% + coolant {coolant_pct}%",
                   _sp(70, 100, 100), 0.30, 0.30, "derating and maximum cooling cut bearing heat build-up"),
    ],
    "HYD-LEAK": [
        Mitigation(("reduce_pressure",), "Reduce press load to {load_pct}%, stroke rate {speed_pct}%",
                   _sp(80, 90), 0.65, 0.20, "a lower working pressure slows the leak"),
        Mitigation(("reduce_pressure",), "Reduce press load to {load_pct}%, stroke rate {speed_pct}%",
                   _sp(60, 80), 0.40, 0.40, "a much lower working pressure slows the leak"),
    ],
    "BELT-SLIP": [
        Mitigation(("derate_speed",), "Derate conveyor to {speed_pct}%", _sp(90), 0.70, 0.10,
                   "a lower belt speed reduces slip"),
        Mitigation(("derate_speed",), "Derate conveyor to {speed_pct}%", _sp(80), 0.50, 0.20,
                   "a lower belt speed reduces slip and wear"),
    ],
    "SPINDLE-VIB": [
        Mitigation(("derate_speed", "reduce_load"), "Derate spindle to {speed_pct}%, load {load_pct}%",
                   _sp(90, 85), 0.70, 0.15, "a lower spindle speed and load reduce vibration"),
        Mitigation(("derate_speed", "reduce_load"), "Derate spindle to {speed_pct}%, load {load_pct}%",
                   _sp(75, 70), 0.40, 0.30, "a lower spindle speed and load cut vibration"),
    ],
    "JOINT-STALL": [
        Mitigation(("limit_velocity",), "Limit robot velocity to {speed_pct}%, load {load_pct}%",
                   _sp(75, 80), 0.70, 0.25, "limiting velocity and load eases the stalled joint"),
        Mitigation(("limit_velocity",), "Limit robot velocity to {speed_pct}%, load {load_pct}%",
                   # design table says speed 50, but the default envelope floor is 60 (max_derate_pct 40): envelope wins
                   _sp(60, 60), 0.45, 0.50, "strongly limiting velocity and load eases the stalled joint"),
    ],
}


def controlled_stop(name: str) -> Mitigation:
    return Mitigation(("controlled_stop",), f"Planned controlled stop of {name}", _sp(0, 0, 50), 0.0, 1.0,
                      "a planned stop beats a catastrophic failure")


# ---------------------------------------------------------------- envelope
def validate_policy(update: dict, current: dict) -> dict:
    """Return the merged policy or raise ValueError. Unknown keys are rejected."""
    merged = dict(current)
    for key, value in update.items():
        if key not in DEFAULT_POLICY:
            raise ValueError(f"unknown policy field {key}")
        if key == "autonomy" and value not in AUTONOMY:
            raise ValueError(f"autonomy must be one of {AUTONOMY}")
        if key in ("enabled", "allow_controlled_stop") and not isinstance(value, bool):
            raise ValueError(f"{key} must be a boolean")
        if key == "max_derate_pct" and (isinstance(value, bool) or not isinstance(value, (int, float))
                                        or not 0 <= value <= MAX_DERATE_LIMIT):
            raise ValueError(f"max_derate_pct must be between 0 and {MAX_DERATE_LIMIT}")
        merged[key] = value
    return merged


def is_stop(sp: dict) -> bool:
    return sp["speed_pct"] == 0 and sp["load_pct"] == 0


def within_envelope(sp: dict, policy: dict) -> bool:
    """True when the setpoints respect the safety envelope. A stop is only allowed if the policy allows it."""
    try:
        speed, load, cool = sp["speed_pct"], sp["load_pct"], sp["coolant_pct"]
    except (KeyError, TypeError):
        return False
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (speed, load, cool)):
        return False
    if not 0 <= cool <= 100:
        return False
    if is_stop(sp):
        return bool(policy.get("allow_controlled_stop"))
    lo = 100 - policy["max_derate_pct"]
    return lo <= speed <= 100 and lo <= load <= 100


def clamp_setpoints(sp: dict, policy: dict) -> dict:
    """Force arbitrary setpoints into the envelope (a stop is only kept if allowed)."""
    lo = 100 - policy["max_derate_pct"]

    def c(v, a, b):
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            v = a                      # junk (bool, NaN, text...) falls back to the safest bound of the range
        return float(max(a, min(b, v)))

    if is_stop(sp) and policy.get("allow_controlled_stop"):
        return {"speed_pct": 0, "load_pct": 0, "coolant_pct": c(sp["coolant_pct"], 0, 100)}
    return {"speed_pct": c(sp["speed_pct"], lo, 100), "load_pct": c(sp["load_pct"], lo, 100),
            "coolant_pct": c(sp["coolant_pct"], 0, 100)}


# ---------------------------------------------------------------- decision rule
def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, x))))


def expected_loss(cost_h: float, ttf: float, wr: float, rate: float, cost_frac: float) -> tuple[float, float]:
    """(expected USD loss, p_fail) of running action `rate` until the repair is done (wr minutes away)."""
    p = 0.0 if rate <= 0 else _sigmoid((wr - ttf / rate) / 5.0)
    return p * cost_h * FAILURE_COST_HOURS + cost_frac * cost_h * wr / 60.0, p


def decide(machine: dict, wr_min: float, policy: dict) -> Optional[dict]:
    """Deterministic mitigation choice, or None. Pure function of its inputs: no I/O, no LLM."""
    fault, ttf = machine.get("fault"), machine.get("predicted_failure_min")
    if not policy.get("enabled") or not fault or ttf is None or ttf <= 0:
        return None
    wr = max(1.0, float(wr_min))
    if ttf > wr * SURVIVES_FACTOR:
        return None
    cost_h = machine["downtime_cost_per_hour"]
    cands = [m for m in CATALOGUE.get(fault["code"], []) if within_envelope(m.setpoints, policy)]
    stop = controlled_stop(machine["name"])
    stop_ok = within_envelope(stop.setpoints, policy)
    if stop_ok:
        cands.append(stop)
    do_nothing, _ = expected_loss(cost_h, ttf, wr, 1.0, 0.0)
    scored = [(expected_loss(cost_h, ttf, wr, c.rate, c.cost_frac), c) for c in cands]
    if not scored:
        return None
    (best_loss, best_p), best = min(scored, key=lambda s: (s[0][0], -s[1].rate))
    if best_p > 0.5 and stop_ok and best is not stop:
        (best_loss, best_p), best = expected_loss(cost_h, ttf, wr, 0.0, 1.0), stop
    if best_loss >= do_nothing:
        return None
    after = None if best.rate <= 0 else ttf / best.rate
    if best is stop:
        reason = (f"Predicted failure in {ttf:.0f} min, but the repair is about {wr:.0f} min away and no gentler action "
                  f"reaches it ({best.effect}).")
    else:
        reason = (f"Predicted failure in {ttf:.0f} min, but the repair is about {wr:.0f} min away; {best.effect} "
                  f"(degradation x{best.rate:.2f}).")
    return {
        "kinds": list(best.kinds), "label": best.label.format(**best.setpoints), "setpoints": dict(best.setpoints),
        "rate": best.rate, "ttf_before": ttf, "ttf_after": after, "reason": reason, "p_fail": best_p,
        "throughput_cost_usd_per_hour": round(best.cost_frac * cost_h, 2),
        "expected_loss_avoided_usd": round(do_nothing - best_loss, 2),
    }


def stronger_candidates(machine: dict, current_rate: float, policy: dict) -> list[dict]:
    """Next stronger actions than the one running (lower rate), within the envelope, strongest last."""
    code = (machine.get("fault") or {}).get("code")
    out = [m for m in CATALOGUE.get(code, []) if m.rate < current_rate and within_envelope(m.setpoints, policy)]
    out.sort(key=lambda m: -m.rate)
    stop = controlled_stop(machine["name"])
    if current_rate > 0 and within_envelope(stop.setpoints, policy):
        out.append(stop)
    return [{"mitigation": m} for m in out]


# ---------------------------------------------------------------- adapters
class ControlAdapter(ABC):
    """Path to real hardware: write bounded setpoints and read them back."""

    @abstractmethod
    def write_setpoints(self, machine_id: str, setpoints: dict, *, rate: float = 1.0,
                        mode: str = "mitigated", action_id: Optional[str] = None) -> dict:
        """Apply setpoints. Returns an Ack {"ok": bool, "readback": setpoints, "detail": str}."""


class SimulatedAdapter(ControlAdapter):
    """Applies setpoints to the simulator (degradation rate, rpm x speed, cooling lowers temperature)."""

    def __init__(self, sim):
        self.sim = sim

    def write_setpoints(self, machine_id, setpoints, *, rate=1.0, mode="mitigated", action_id=None) -> dict:
        readback = self.sim.apply_control(machine_id, setpoints, rate, mode, action_id)
        return {"ok": readback == setpoints, "readback": readback, "detail": "simulated"}


OPCUA_NODE_MAP_EXAMPLE = {
    # machine id -> setpoint -> OPC UA node id (loaded from a config file in a real deployment)
    "PUMP-03": {"speed_pct": "ns=2;s=Pump03.Setpoint.SpeedPct", "coolant_pct": "ns=2;s=Pump03.Setpoint.CoolantPct"},
}


class OpcUaAdapter(ControlAdapter):
    """Documented stub for a real PLC. NOT implemented: it raises instead of writing anything.

    Production notes:
      * Map speed_pct / load_pct / coolant_pct to OPC UA node ids from a config file (OPCUA_NODE_MAP_EXAMPLE),
        write with `asyncua` (Client.get_node(id).write_value(...)), then READ BACK each node and compare
        before reporting ok.
      * Only ever write to setpoint nodes. Never write to safety PLC / safety-rated I/O; a controlled stop goes
        through the normal stop sequence, not through the safety circuit.
      * Place the adapter in its own network zone with a conduit to the control zone (IEC 62443 zones and
        conduits), authenticate with certificates (OPC UA SignAndEncrypt), and keep the envelope check in this
        service as well as the PLC's own limits.
    """

    def __init__(self, node_map: Optional[dict] = None):
        self.node_map = node_map or OPCUA_NODE_MAP_EXAMPLE

    def write_setpoints(self, machine_id, setpoints, *, rate=1.0, mode="mitigated", action_id=None) -> dict:
        raise NotImplementedError("OpcUaAdapter is a documented stub; use SimulatedAdapter")


# ---------------------------------------------------------------- manager
class ControlManager:
    """Owns the policy and the lifecycle of control actions. Pure logic; the agent emits events around it."""

    def __init__(self, sim, adapter: ControlAdapter, is_locked: Callable[[str], bool]):
        self.sim, self.adapter, self.is_locked = sim, adapter, is_locked
        self.policy = dict(DEFAULT_POLICY)
        self.lock = threading.RLock()
        self.listeners: list[Callable[[dict], None]] = []
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.actions: list[dict] = []
            self._next = 1000
            self._last_new: dict[str, float] = {}
            self._rate: dict[str, float] = {}          # action id -> degradation multiplier (internal)
            self._baseline: dict[str, float] = {}      # action id -> nominal health loss per minute at activation
            self._activated_at: dict[str, float] = {}
            self._supersedes: dict[str, str] = {}      # new action id -> action it replaces on activation
            self.failures_prevented = 0

    # ---- helpers
    def _notify(self, action: dict) -> None:
        for fn in list(self.listeners):
            try:
                fn(copy.deepcopy(action))
            except Exception:
                pass

    def get(self, action_id: str) -> dict:
        with self.lock:
            for a in self.actions:
                if a["id"] == action_id:
                    return a
        raise ControlNotFound(action_id)

    def list(self, limit: int = 50) -> list[dict]:
        with self.lock:
            return copy.deepcopy(self.actions[-limit:]) if limit > 0 else []

    def update_policy(self, update: dict) -> dict:
        with self.lock:
            self.policy = validate_policy(update, self.policy)
            return dict(self.policy)

    def active_for(self, machine_id: str) -> list[dict]:
        return [a for a in self.actions if a["machine_id"] == machine_id and a["status"] == "active"]

    def _now(self) -> float:
        return self.sim.sim_time

    # ---- create
    def _create(self, machine: dict, d: dict, previous: dict) -> dict:
        self._next += 1
        action = {
            "id": f"CA-{self._next}", "machine_id": machine["id"], "created_at": now_iso(), "kinds": d["kinds"],
            "label": d["label"], "setpoints": d["setpoints"], "previous_setpoints": dict(previous),
            "status": "proposed", "autonomy": self.policy["autonomy"], "reason": d["reason"], "rationale": None,
            "rationale_engine": None,
            "ttf_before_min": None if d["ttf_before"] is None else int(round(d["ttf_before"])),
            "ttf_after_min": None if d["ttf_after"] is None else int(round(d["ttf_after"])),
            "throughput_cost_usd_per_hour": d["throughput_cost_usd_per_hour"],
            "expected_loss_avoided_usd": d["expected_loss_avoided_usd"],
        }
        self._rate[action["id"]] = d["rate"]
        self.actions.append(action)
        return action

    def propose(self, machine: dict, wr_min: float, force: bool = False) -> Optional[dict]:
        """Decide for a machine and create an action (auto: also activate it). None when nothing is to be done."""
        with self.lock:
            mid = machine["id"]
            if not self.policy["enabled"] or self.is_locked(mid):   # interlock: lockout/tagout in progress
                return None
            if self.active_for(mid) or any(a["machine_id"] == mid and a["status"] == "proposed" for a in self.actions):
                return None                                          # one open action per machine
            if not force and self._now() - self._last_new.get(mid, -1e9) < RATE_LIMIT_S:
                return None
            d = decide(machine, wr_min, self.policy)
            if d is None:
                return None
            action = self._create(machine, d, machine.get("control", {}).get("setpoints", NOMINAL))
            self._last_new[mid] = self._now()
            if self.policy["autonomy"] == "auto":
                self._activate(action)
            self._notify(action)
            return action

    def _activate(self, action: dict) -> None:
        mid = action["machine_id"]
        if self.is_locked(mid):
            raise ControlConflict(f"{mid} is locked out: a technician is repairing it")
        if not within_envelope(action["setpoints"], self.policy):
            raise ControlConflict("setpoints are outside the safety envelope")
        rate = self._rate[action["id"]]
        mode = "safe_stop" if is_stop(action["setpoints"]) else "mitigated"
        self._baseline[action["id"]] = self.sim.nominal_loss_per_min(mid)
        ack = self.adapter.write_setpoints(mid, action["setpoints"], rate=rate, mode=mode, action_id=action["id"])
        if not ack.get("ok"):
            raise ControlConflict("the control system did not confirm the setpoints")
        action["status"] = "active"
        self._activated_at[action["id"]] = self._now()
        old_id = self._supersedes.pop(action["id"], None)
        if old_id:
            old = self.get(old_id)
            if old["status"] == "active":
                old["status"] = "escalated"
                self._notify(old)

    # ---- human decisions
    def approve(self, action_id: str) -> dict:
        with self.lock:
            a = self.get(action_id)
            if a["status"] != "proposed":
                raise ControlConflict(f"action is {a['status']}, not proposed")
            self._activate(a)
            self._notify(a)
            return copy.deepcopy(a)

    def reject(self, action_id: str) -> dict:
        with self.lock:
            a = self.get(action_id)
            if a["status"] != "proposed":
                raise ControlConflict(f"action is {a['status']}, not proposed")
            a["status"] = "rejected"
            self._supersedes.pop(action_id, None)
            self._notify(a)
            return copy.deepcopy(a)

    def revert(self, action_id: str) -> dict:
        """Human override (always allowed): restore the setpoints that were in force before the action."""
        with self.lock:
            a = self.get(action_id)
            if a["status"] != "active":
                raise ControlConflict(f"action is {a['status']}, not active")
            prev = a["previous_setpoints"]
            nominal = prev == NOMINAL
            self.adapter.write_setpoints(a["machine_id"], prev, rate=1.0,
                                         mode="nominal" if nominal else "mitigated", action_id=None if nominal else a["id"])
            a["status"] = "reverted"
            self._notify(a)
            return copy.deepcopy(a)

    # ---- lifecycle hooks used by the agent
    def restore(self, machine_id: str) -> list[dict]:
        """Repair finished: back to nominal. Active actions complete (a prevented failure); open proposals are dropped."""
        done = []
        with self.lock:
            for a in self.actions:
                if a["machine_id"] != machine_id:
                    continue
                if a["status"] == "active":
                    a["status"] = "completed"
                    self.failures_prevented += 1
                    done.append(a)
                elif a["status"] == "proposed":
                    a["status"] = "rejected"
                    done.append(a)
                else:
                    continue
                self._supersedes.pop(a["id"], None)
                self._notify(a)
            return copy.deepcopy(done)

    def clear_for_new_fault(self, machine_id: str) -> None:
        """A fresh fault was injected (the simulator already reset the setpoints): retire old actions."""
        with self.lock:
            for a in self.actions:
                if a["machine_id"] == machine_id and a["status"] in ("active", "proposed"):
                    a["status"] = "reverted" if a["status"] == "active" else "rejected"
                    self._supersedes.pop(a["id"], None)
                    self._notify(a)
            self._last_new.pop(machine_id, None)

    def watchdog(self, machine_lookup: Callable[[str], Optional[dict]], wr_lookup: Callable[[str], float]) -> list[dict]:
        """Escalate actions that have not improved the health-loss slope by 40% within 30 simulated seconds."""
        escalated = []
        with self.lock:
            for a in [x for x in self.actions if x["status"] == "active"]:
                age = self._now() - self._activated_at.get(a["id"], self._now())
                if age < WATCHDOG_S or self.is_locked(a["machine_id"]):
                    continue
                if any(self._supersedes.get(x["id"]) == a["id"] for x in self.actions if x["status"] == "proposed"):
                    continue  # an escalation is already waiting for approval
                base = self._baseline.get(a["id"], 0.0)
                now_slope = self.sim.measured_loss_per_min(a["machine_id"])
                if base <= 0 or now_slope is None:
                    continue
                if 1.0 - now_slope / base >= WATCHDOG_MIN_IMPROVEMENT:
                    self._activated_at[a["id"]] = self._now()   # healthy: re-arm the check
                    continue
                m = machine_lookup(a["machine_id"])
                if m is None or not m.get("fault"):
                    continue
                options = stronger_candidates(m, self._rate[a["id"]], self.policy)
                if not options:
                    continue
                mit = options[0]["mitigation"]
                ttf = m["predicted_failure_min"]
                cost_h = m["downtime_cost_per_hour"]
                wr = max(1.0, wr_lookup(m["id"]))
                loss, p = expected_loss(cost_h, ttf if ttf else wr, wr, mit.rate, mit.cost_frac)
                d = {"kinds": list(mit.kinds), "label": mit.label.format(**mit.setpoints), "setpoints": dict(mit.setpoints),
                     "rate": mit.rate, "ttf_before": a["ttf_before_min"],
                     "ttf_after": None if mit.rate <= 0 else (a["ttf_before_min"] or ttf or 0) / mit.rate,
                     "reason": f"Escalated from '{a['label']}': health loss did not improve by 40% within "
                               f"{WATCHDOG_S:.0f} s; {mit.effect}.",
                     "throughput_cost_usd_per_hour": round(mit.cost_frac * cost_h, 2),
                     "expected_loss_avoided_usd": a["expected_loss_avoided_usd"]}
                new = self._create(m, d, a["previous_setpoints"])   # revert still returns to pre-mitigation state
                new["autonomy"] = self.policy["autonomy"]
                self._supersedes[new["id"]] = a["id"]
                self._activated_at[a["id"]] = self._now()          # do not re-escalate every tick
                if self.policy["autonomy"] == "auto":
                    try:
                        self._activate(new)
                    except ControlConflict:
                        new["status"] = "rejected"
                self._notify(new)
                escalated.append(copy.deepcopy(new))
        return escalated

    def set_rationale(self, action_id: str, text: str, engine: str) -> None:
        """Attach the LLM's explanation. Text only: this never touches setpoints, status or numbers."""
        with self.lock:
            a = self.get(action_id)
            a["rationale"], a["rationale_engine"] = text, engine
            self._notify(a)

    # ---- KPIs
    def kpis(self) -> dict:
        with self.lock:
            active = [a for a in self.actions if a["status"] == "active"]
            return {
                "mitigations_active": len(active),
                "failures_prevented": self.failures_prevented,
                "ttf_extended_min": sum(max(0, (a["ttf_after_min"] or 0) - (a["ttf_before_min"] or 0))
                                        for a in active if a["ttf_after_min"] is not None),
                "throughput_cost_usd_per_hour": round(sum(a["throughput_cost_usd_per_hour"] for a in active), 2),
            }
