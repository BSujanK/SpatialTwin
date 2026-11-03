"""Telemetry simulator: five machines, jittering sensors, drifting faults."""
from __future__ import annotations

import copy
import random
import threading
from collections import deque
from datetime import datetime
from typing import Optional

HEALTH_FLOOR = 5.0
RESOLVED_HEALTH = 95.0
HISTORY_LEN = 30  # ~30 s of health samples for the trend


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def status_for(health: float) -> str:
    if health >= 75:
        return "ok"
    if health >= 45:
        return "warning"
    return "fault"


# Fault catalogue. start_health: health when injected. ttf_min: minutes to health 0
# at the injected trend. drift: per-second change of the sensor mean.
FAULTS: dict[str, dict] = {
    "BRG-OVERHEAT": {
        "description": "Drive-end bearing overheating, vibration above ISO 10816 limit",
        "part": "bearing", "start_health": 40.0, "ttf_min": 18.0,
        "drift": {"temperature_c": 0.10, "vibration_mm_s": 0.012},
    },
    "BELT-SLIP": {
        "description": "Belt slipping: drive speed 12% below setpoint",
        "part": "belt", "start_health": 62.0, "ttf_min": 95.0,
        "drift": {"vibration_mm_s": 0.005, "rpm": -0.05},
    },
    "HYD-LEAK": {
        "description": "Hydraulic pressure dropping 4 bar/min: suspected line leak",
        "part": "hydraulic_line", "start_health": 38.0, "ttf_min": 40.0,
        "drift": {"pressure_bar": -0.067, "temperature_c": 0.02},
    },
    "SPINDLE-VIB": {
        "description": "Spindle vibration above limit: worn spindle bearings or imbalance",
        "part": "spindle", "start_health": 55.0, "ttf_min": 30.0,
        "drift": {"vibration_mm_s": 0.02, "temperature_c": 0.05},
    },
    "JOINT-STALL": {
        "description": "Arm joint stalling under load: motor current spikes, positioning errors",
        "part": "arm_joint", "start_health": 50.0, "ttf_min": 25.0,
        "drift": {"temperature_c": 0.07, "vibration_mm_s": 0.015},
    },
}

# Noise (std dev) per sensor for a healthy machine.
NOISE = {"temperature_c": 0.25, "vibration_mm_s": 0.06, "pressure_bar": 0.05, "rpm": 8.0}

# Initial state: must equal shared/mock/machines.json exactly.
INITIAL_MACHINES: list[dict] = [
    {
        "id": "CNC-01", "name": "CNC Mill", "type": "cnc",
        "position": {"x": -4, "y": 0, "z": -2},
        "status": "ok", "health": 91, "criticality": 4,
        "sensors": {"temperature_c": 41.2, "vibration_mm_s": 1.8, "pressure_bar": 6.1, "rpm": 8000},
        "fault": None, "downtime_cost_per_hour": 4000, "predicted_failure_min": None,
    },
    {
        "id": "CONV-02", "name": "Main Conveyor", "type": "conveyor",
        "position": {"x": 0, "y": 0, "z": -2},
        "status": "warning", "health": 64, "criticality": 5,
        "sensors": {"temperature_c": 38.5, "vibration_mm_s": 4.9, "pressure_bar": 0.0, "rpm": 140},
        "fault": {
            "code": "BELT-SLIP",
            "description": "Belt slipping: drive speed 12% below setpoint",
            "part": "belt", "since": "2026-11-03T09:12:00+05:30",
        },
        "downtime_cost_per_hour": 12000, "predicted_failure_min": 95,
    },
    {
        "id": "PUMP-03", "name": "Coolant Pump", "type": "pump",
        "position": {"x": 4, "y": 0, "z": -2},
        "status": "fault", "health": 22, "criticality": 3,
        "sensors": {"temperature_c": 96.4, "vibration_mm_s": 11.3, "pressure_bar": 2.2, "rpm": 2950},
        "fault": {
            "code": "BRG-OVERHEAT",
            "description": "Drive-end bearing overheating, vibration above ISO 10816 limit",
            "part": "bearing", "since": "2026-11-03T09:05:00+05:30",
        },
        "downtime_cost_per_hour": 3000, "predicted_failure_min": 18,
    },
    {
        "id": "ROBOT-04", "name": "Welding Robot", "type": "robot_arm",
        "position": {"x": -2, "y": 0, "z": 2},
        "status": "ok", "health": 88, "criticality": 4,
        "sensors": {"temperature_c": 47.0, "vibration_mm_s": 2.1, "pressure_bar": 5.8, "rpm": 0},
        "fault": None, "downtime_cost_per_hour": 8000, "predicted_failure_min": None,
    },
    {
        "id": "PRESS-05", "name": "Hydraulic Press", "type": "press",
        "position": {"x": 2, "y": 0, "z": 2},
        "status": "fault", "health": 35, "criticality": 5,
        "sensors": {"temperature_c": 62.7, "vibration_mm_s": 3.4, "pressure_bar": 141.0, "rpm": 0},
        "fault": {
            "code": "HYD-LEAK",
            "description": "Hydraulic pressure dropping 4 bar/min: suspected line leak",
            "part": "hydraulic_line", "since": "2026-11-03T09:15:00+05:30",
        },
        "downtime_cost_per_hour": 15000, "predicted_failure_min": 40,
    },
]


class Simulator:
    """Holds live machine state. Thread-safe enough for a demo (single lock)."""

    def __init__(self, seed: Optional[int] = None, speed: float = 1.0):
        self.rng = random.Random(seed)
        self.speed = speed
        self.lock = threading.RLock()
        self.machines: dict[str, dict] = {}
        self._base: dict[str, dict] = {}      # noise-free sensor means
        self._healthy: dict[str, dict] = {}   # sensor means when healthy
        self._rate: dict[str, float] = {}     # health lost per minute while faulted
        self._hist: dict[str, deque] = {}
        self.reset()

    # ---------- state ----------
    def reset(self) -> None:
        with self.lock:
            self.machines = {m["id"]: copy.deepcopy(m) for m in INITIAL_MACHINES}
            self._base = {i: dict(m["sensors"]) for i, m in self.machines.items()}
            self._healthy = {i: dict(m["sensors"]) for i, m in self.machines.items()}
            # Healthy means for machines that start faulted (sensible "after repair" values).
            self._healthy["CONV-02"].update(vibration_mm_s=2.0, rpm=160)
            self._healthy["PUMP-03"].update(temperature_c=55.0, vibration_mm_s=2.0, pressure_bar=4.5)
            self._healthy["PRESS-05"].update(temperature_c=52.0, vibration_mm_s=2.2, pressure_bar=180.0)
            self._rate = {}
            self._hist = {i: deque(maxlen=HISTORY_LEN) for i in self.machines}
            for i, m in self.machines.items():
                if m["fault"]:
                    ttf = m["predicted_failure_min"] or FAULTS[m["fault"]["code"]]["ttf_min"]
                    self._rate[i] = m["health"] / ttf

    def snapshot(self) -> list[dict]:
        with self.lock:
            return copy.deepcopy(list(self.machines.values()))

    def get(self, machine_id: str) -> Optional[dict]:
        with self.lock:
            m = self.machines.get(machine_id)
            return copy.deepcopy(m) if m else None

    # ---------- faults ----------
    def inject_fault(self, machine_id: str, code: str) -> dict:
        """Force a fault. Raises KeyError for an unknown machine or code."""
        spec = FAULTS[code]
        with self.lock:
            m = self.machines[machine_id]
            m["fault"] = {
                "code": code, "description": spec["description"],
                "part": spec["part"], "since": now_iso(),
            }
            m["health"] = min(m["health"], spec["start_health"])
            m["status"] = status_for(m["health"])
            self._rate[machine_id] = m["health"] / spec["ttf_min"]
            self._hist[machine_id].clear()
            m["predicted_failure_min"] = int(round(spec["ttf_min"]))
            return copy.deepcopy(m)

    def resolve(self, machine_id: str) -> dict:
        """Repair finished: machine goes back to ok, health 95."""
        with self.lock:
            m = self.machines[machine_id]
            m["fault"] = None
            m["health"] = RESOLVED_HEALTH
            m["status"] = "ok"
            m["predicted_failure_min"] = None
            self._base[machine_id] = dict(self._healthy[machine_id])
            m["sensors"] = dict(self._healthy[machine_id])
            self._rate.pop(machine_id, None)
            self._hist[machine_id].clear()
            return copy.deepcopy(m)

    # ---------- time ----------
    def tick(self, dt: float = 1.0) -> list[tuple[str, str, str]]:
        """Advance one step. Returns status changes as (machine_id, old, new)."""
        changes: list[tuple[str, str, str]] = []
        with self.lock:
            for mid, m in self.machines.items():
                old = m["status"]
                base = self._base[mid]
                if m["fault"]:
                    spec = FAULTS[m["fault"]["code"]]
                    for k, per_s in spec["drift"].items():
                        base[k] = max(0.0, base[k] + per_s * dt * self.speed)
                    drop = self._rate.get(mid, 1.0) / 60.0 * dt * self.speed
                    m["health"] = max(HEALTH_FLOOR, m["health"] - drop)
                else:
                    # healthy: health wanders slightly but never leaves "ok"
                    m["health"] = min(99.0, max(76.0, m["health"] + self.rng.gauss(0, 0.05)))
                for k in base:
                    v = base[k] + self.rng.gauss(0, NOISE[k]) * (1.0 if base[k] else 0.0)
                    m["sensors"][k] = int(round(v)) if k == "rpm" else round(max(0.0, v), 1)
                m["status"] = status_for(m["health"])
                self._update_prediction(mid)
                if m["status"] != old:
                    changes.append((mid, old, m["status"]))
        return changes

    def _update_prediction(self, mid: str) -> None:
        m = self.machines[mid]
        hist = self._hist[mid]
        if not m["fault"]:
            hist.clear()
            m["predicted_failure_min"] = None
            return
        hist.append(m["health"])
        if len(hist) < 8:  # not enough trend yet: keep the catalogue estimate
            return
        n = len(hist)
        xs = range(n)
        mx, my = (n - 1) / 2.0, sum(hist) / n
        den = sum((x - mx) ** 2 for x in xs)
        slope_per_s = sum((x - mx) * (y - my) for x, y in zip(xs, hist)) / den
        if slope_per_s >= -1e-5:
            m["predicted_failure_min"] = None
        else:
            m["predicted_failure_min"] = max(1, min(999, int(round(m["health"] / (-slope_per_s * 60.0)))))
