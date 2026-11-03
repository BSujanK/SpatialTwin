"""Autonomous maintenance agent: detect -> diagnose -> schedule -> dispatch -> guide -> resolve.

Every decision is appended to an event log (AgentEvent) and pushed to listeners (the websocket hub).
Pure logic, no I/O: the copilot calls on_guide()/on_resolve(); the telemetry loop calls on_tick().
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Optional

from . import llm, scheduler
from .control import ControlManager, SimulatedAdapter
from .simulator import Simulator, now_iso

SEVERITY = {"ok": 0, "warning": 1, "fault": 2}
TECHS = scheduler.TECHS


class Agent:
    def __init__(self, sim: Simulator):
        self.sim = sim
        self.lock = threading.RLock()
        self.listeners: list[Callable[[dict], None]] = []
        self.control = ControlManager(sim, SimulatedAdapter(sim), self._is_locked)
        self.reset()

    # ---------- setup ----------
    def reset(self) -> None:
        """Clear the log and KPIs, then register faults that already exist (no dispatch yet)."""
        with self.lock:
            self._gen = getattr(self, "_gen", 0) + 1
            self.control.reset()
            self.events: list[dict] = []
            self._next_id = 1
            self._wo = 1000
            self.schedule = scheduler.compute_schedule(self.sim.snapshot())
            self._last_order: Optional[list] = None
            self.avoided = 0.0
            self.repairs = 0
            self.mttrs: list[float] = []
            self.tech: dict[str, dict] = {
                t: {"status": "idle", "machine_id": None, "wo": None} for t in TECHS
            }
            self._detected_at: dict[str, float] = {}
            now = time.time()
            started = False
            for m in self.sim.snapshot():
                if m["status"] != "ok":
                    self._detected_at[m["id"]] = now
                    self._detect(m, None)
                    self._diagnose(m)
                    started = True
            if started:
                self._reschedule()

    def add_listener(self, fn: Callable[[dict], None]) -> None:
        self.listeners.append(fn)

    # ---------- events ----------
    def _emit(self, kind: str, machine_id: Optional[str], message: str) -> dict:
        with self.lock:
            ev = {"id": self._next_id, "ts": now_iso(), "kind": kind,
                  "machine_id": machine_id, "message": message}
            self._next_id += 1
            self.events.append(ev)
            self.events = self.events[-500:]
        for fn in list(self.listeners):
            try:
                fn(ev)
            except Exception:
                pass
        return ev

    def get_events(self, limit: int = 50) -> list[dict]:
        with self.lock:
            return list(self.events[-limit:]) if limit > 0 else []

    # ---------- loop stages ----------
    def _detect(self, m: dict, old: Optional[str]) -> None:
        s = m["sensors"]
        what = m["fault"]["description"] if m["fault"] else "abnormal readings"
        arrow = f"{old}→{m['status']}" if old else m["status"]
        self._emit("detect", m["id"],
                   f"{m['name']} {arrow}: {what}. Temp {s['temperature_c']} °C, vibration {s['vibration_mm_s']} mm/s.")

    def _diagnose(self, m: dict) -> None:
        f = m["fault"]
        if not f:
            self._emit("diagnose", m["id"], f"Diagnosis: no fault code yet for {m['name']}; monitoring.")
            return
        pf = m["predicted_failure_min"]
        eta = f" Predicted failure in ~{pf} min." if pf else ""
        self._emit("diagnose", m["id"], f"Diagnosis: {f['code']} ({f['part'].replace('_', ' ')}).{eta}")
        self._root_cause_async(m)

    def _root_cause_async(self, m: dict) -> None:
        """Ask the LLM for a one-sentence root cause in the background; never blocks the loop."""
        if not llm.available():
            return
        gen = self._gen
        llm.worker.submit(lambda: self._root_cause(m, gen))  # single background worker, newest first

    def _root_cause(self, m: dict, gen: int) -> None:
        f, s = m["fault"], m["sensors"]
        system = ("You are a senior industrial maintenance engineer. In ONE sentence (max 30 words) give the most "
                  "likely root cause and the recommended action. No markdown, no preamble.")
        user = (f"Machine {m['name']} ({m['id']}), health {m['health']:.0f}/100. Fault code {f['code']}: "
                f"{f['description']}. Live sensors: temperature {s['temperature_c']} C, vibration "
                f"{s['vibration_mm_s']} mm/s, pressure {s['pressure_bar']} bar, {s['rpm']} rpm. "
                f"Predicted failure in {m['predicted_failure_min']} min.")
        try:
            res = llm.chat(system, [{"role": "user", "content": user}], max_tokens=80, background=True)
        except Exception:
            return
        if not res or gen != self._gen:  # failure: emit nothing; stale after a demo reset: drop
            return
        text, engine = res
        prefix = "Qualcomm Cloud AI 100: " if engine.startswith(llm.QUALCOMM_LABEL) else "Anthropic: "
        self._emit("diagnose", m["id"], prefix + " ".join(text.split()))

    def _reschedule(self) -> None:
        """Re-run the annealer, log it, and count savings when the order changed."""
        sched = scheduler.compute_schedule(self.sim.snapshot())
        self.schedule = sched
        if not sched["queue"]:
            self._last_order = []
            return
        order = [(q["machine_id"], q["technician"]) for q in sched["queue"]]
        if order != self._last_order:
            self.avoided += sched["savings_usd"]
        self._last_order = order
        seq = " → ".join(q["machine_id"] for q in sched["queue"])
        self._emit("schedule", None,
                   f"Re-optimized repair queue (QUBO annealing, {scheduler.last_solve_ms:.0f} ms): "
                   f"{seq}. Saves ${sched['savings_usd']:,.0f} vs greedy.")

    def _assigned(self) -> set:
        return {t["machine_id"] for t in self.tech.values() if t["machine_id"]}

    def _dispatch(self) -> None:
        """Give every idle technician the best queued machine nobody is working on."""
        busy = self._assigned()
        for name in TECHS:
            st = self.tech[name]
            if st["status"] != "idle":
                continue
            todo = [q for q in self.schedule["queue"] if q["machine_id"] not in busy]
            if not todo:
                return
            pick = next((q for q in todo if q["technician"] == name), todo[0])
            self._wo += 1
            st.update(status="en_route", machine_id=pick["machine_id"], wo=f"WO-{self._wo}")
            busy.add(pick["machine_id"])
            m = self.sim.get(pick["machine_id"])
            code = m["fault"]["code"] if m and m["fault"] else "inspection"
            self._emit("dispatch", pick["machine_id"],
                       f"Dispatched {name} with work order {st['wo']} ({code}, est. {pick['est_repair_min']} min).")

    # ---------- triggers ----------
    def on_tick(self, changes: list) -> None:
        """Called after each simulator tick with status changes (machine_id, old, new)."""
        worse = [(i, o, n) for i, o, n in changes if SEVERITY[n] > SEVERITY[o]]
        with self.lock:
            if worse:
                for mid, old, _ in worse:
                    m = self.sim.get(mid)
                    self._detected_at.setdefault(mid, time.time())
                    self._detect(m, old)
                    self._diagnose(m)
                    self._mitigate(m)
                self._reschedule()
                self._dispatch()
            self._control_tick()

    def on_inject(self, machine_id: str) -> None:
        """A fault was forced on machine_id (demo)."""
        with self.lock:
            self.control.clear_for_new_fault(machine_id)
            m = self.sim.get(machine_id)
            self._detected_at[machine_id] = time.time()
            self._detect(m, None)
            self._diagnose(m)
            self._mitigate(m, force=True)
            self._reschedule()
            self._dispatch()

    def on_guide(self, machine_id: str) -> None:
        """Technician started the guided repair (first copilot 'start')."""
        with self.lock:
            name = self._tech_for(machine_id)
            if name is None:  # walked up without a work order: take an idle technician
                name = next((t for t in TECHS if self.tech[t]["status"] == "idle"), None)
                if name:
                    self._wo += 1
                    self.tech[name].update(machine_id=machine_id, wo=f"WO-{self._wo}")
                else:
                    name = self._reroute(machine_id)
            if name is None or self.tech[name]["status"] == "repairing":
                return
            self.tech[name]["status"] = "repairing"
            m = self.sim.get(machine_id)
            self._emit("guide", machine_id,
                       f"{name} started the AR-guided repair of {m['name']} ({self.tech[name]['wo']}).")

    def _reroute(self, machine_id: str) -> Optional[str]:
        """No tech assigned and none idle: pull the tech holding the lowest-ranked job (not yet repairing)."""
        rank = {q["machine_id"]: q["rank"] for q in self.schedule["queue"]}
        cands = [(rank.get(t["machine_id"], 99), n) for n, t in self.tech.items()
                 if t["machine_id"] and t["status"] == "en_route"]
        if not cands:
            return None
        _, name = max(cands)
        old = self.tech[name]["machine_id"]
        self._wo += 1
        self.tech[name].update(machine_id=machine_id, wo=f"WO-{self._wo}")
        m = self.sim.get(machine_id)
        self._emit("dispatch", machine_id,
                   f"Re-routed {name} from {old} to {m['name']} ({machine_id}) with work order {self.tech[name]['wo']}.")
        return name

    def on_resolve(self, machine_id: str) -> None:
        """Last copilot step done. Marks the machine ok if the caller has not already."""
        with self.lock:
            m = self.sim.get(machine_id)
            if m and m["status"] != "ok":
                self.sim.resolve(machine_id)
                m = self.sim.get(machine_id)
            started = self._detected_at.pop(machine_id, None)
            mttr = (time.time() - started) / 60.0 if started else None
            if mttr is not None:
                self.mttrs.append(mttr)
            self.repairs += 1
            name = self._tech_for(machine_id)
            if name:
                self.tech[name].update(status="idle", machine_id=None, wo=None)
            tail = f" MTTR {mttr:.1f} min." if mttr is not None else ""
            self._emit("resolve", machine_id,
                       f"{m['name']} repaired and back to OK (health {int(m['health'])}).{tail}")
            if any(a["status"] == "completed" for a in self.control.restore(machine_id)):
                self._emit("restore", machine_id, f"Restored {m['name']} to nominal setpoints (100% speed, 100% load).")
            self._reschedule()
            self._dispatch()

    def _tech_for(self, machine_id: str) -> Optional[str]:
        return next((n for n, t in self.tech.items() if t["machine_id"] == machine_id), None)

    # ---------- autonomous control (B10/B11) ----------
    # The deterministic engine in control.py chooses every setpoint. The LLM below only explains an action.
    def _is_locked(self, machine_id: str) -> bool:
        """Lockout/tagout interlock: no control action while a technician is repairing the machine."""
        return any(t["machine_id"] == machine_id and t["status"] == "repairing" for t in self.tech.values())

    def _wait_plus_repair(self, machine_id: str) -> float:
        """Minutes until the repair of this machine would be complete, from the current schedule."""
        queue = self.schedule["queue"]
        item = next((q for q in queue if q["machine_id"] == machine_id), None)
        if item is None:
            return 30.0
        tech = item["technician"]
        wait = sum(q["est_repair_min"] for q in queue if q["technician"] == tech and q["rank"] < item["rank"])
        st = self.tech[tech]
        if st["status"] != "idle" and st["machine_id"] not in (None, machine_id):
            busy = next((q["est_repair_min"] for q in queue if q["machine_id"] == st["machine_id"]), 25)
            wait += busy                                   # technician is still busy with another job
        return float(wait + item["est_repair_min"])

    def _describe(self, a: dict) -> str:
        after = "stopped" if a["ttf_after_min"] is None else f"{a['ttf_after_min']} min"
        return (f"{a['label']}: fails in {a['ttf_before_min']} → {after}, "
                f"-${a['throughput_cost_usd_per_hour']:,.0f}/h throughput, avoids ${a['expected_loss_avoided_usd']:,.0f} expected loss.")

    def _mitigate(self, m: dict, force: bool = False) -> None:
        """After diagnose, before schedule: ask the engine for a mitigation (never the LLM) and log it."""
        if not self.control.policy["enabled"]:
            return
        self.schedule = scheduler.compute_schedule(self.sim.snapshot())   # provisional, to know the wait
        action = self.control.propose(m, self._wait_plus_repair(m["id"]), force=force)
        if action is None:
            return
        prefix = {"active": "Auto-mitigation",
                  "proposed": "Recommended mitigation (advise mode, not applied)" if action["autonomy"] == "advise"
                  else "Proposed mitigation (needs operator approval)"}.get(action["status"], "Mitigation")
        self._emit("mitigate", m["id"], f"{prefix}: {self._describe(action)}")
        self._rationale_async(action)

    def _control_tick(self) -> None:
        for esc in self.control.watchdog(self.sim.get, self._wait_plus_repair):
            self._emit("escalate", esc["machine_id"], f"Escalated: {self._describe(esc)} Health loss had not improved enough.")
            self._rationale_async(esc)
            self._reschedule()

    def _rationale_async(self, action: dict) -> None:
        if not llm.available():
            return
        gen, aid = self._gen, action["id"]
        facts = dict(action)
        llm.worker.submit(lambda: self._rationale(facts, aid, gen), priority=1)  # ahead of root-cause notes

    def _rationale(self, a: dict, aid: str, gen: int) -> None:
        system = ("You explain automatic equipment protection actions to a plant operator. Write ONE sentence "
                  "(max 35 words), plain language, no markdown. Explain why this action helps and what it costs. "
                  "Use only the numbers given. Do not recommend different settings.")
        after = "n/a (machine stopped)" if a["ttf_after_min"] is None else f"{a['ttf_after_min']} min"
        user = (f"Machine {a['machine_id']}. Action: {a['label']}. Reason: {a['reason']} Time to failure before "
                f"{a['ttf_before_min']} min, after {after}. Throughput cost ${a['throughput_cost_usd_per_hour']:.0f} per hour. "
                f"Expected loss avoided ${a['expected_loss_avoided_usd']:.0f}.")
        try:
            res = llm.chat(system, [{"role": "user", "content": user}], max_tokens=90, background=True)
        except Exception:
            return
        if not res or gen != self._gen:
            return
        text, engine = res
        try:
            self.control.set_rationale(aid, " ".join(text.split()), engine)   # text only; numbers never change
        except Exception:
            pass

    def control_approve(self, action_id: str) -> dict:
        with self.lock:
            a = self.control.approve(action_id)
            self._emit("mitigate", a["machine_id"], f"Operator approved: {self._describe(a)}")
            self._reschedule()
            self._dispatch()
            return a

    def control_reject(self, action_id: str) -> dict:
        with self.lock:
            a = self.control.reject(action_id)
            self._emit("mitigate", a["machine_id"], f"Operator rejected: {a['label']}.")
            return a

    def control_revert(self, action_id: str) -> dict:
        with self.lock:
            a = self.control.revert(action_id)
            self._emit("restore", a["machine_id"], f"Operator reverted: {a['label']}. Previous setpoints restored.")
            self._reschedule()
            return a

    # ---------- KPIs ----------
    def kpis(self) -> dict:
        bad = [m for m in self.sim.snapshot() if m["status"] != "ok"]
        with self.lock:
            return {
                "active_faults": len(bad),
                "at_risk_usd_per_hour": sum(m["downtime_cost_per_hour"] for m in bad),
                "repairs_completed": self.repairs,
                "avg_mttr_min": round(sum(self.mttrs) / len(self.mttrs), 1) if self.mttrs else None,
                "downtime_cost_avoided_usd": round(self.avoided, 2),
                "technicians": [
                    {"name": n, "status": t["status"], "machine_id": t["machine_id"]}
                    for n, t in self.tech.items()
                ],
                **self.control.kpis(),
            }
