"""Repair copilot. Step advancement is decided here, in code. The LLM only phrases replies."""
from __future__ import annotations

from . import llm
from .procedures import get_procedure

START = {"start", "begin", "go"}
ADVANCE = {"done", "next", "ok", "okay"}


def classify(message: str) -> str:
    """'start' | 'advance' | 'question'."""
    m = message.strip().lower().strip(".!?")
    if m in START:
        return "start"
    if m in ADVANCE:
        return "advance"
    return "question"


def _sensors(machine: dict) -> str:
    s = machine["sensors"]
    return (f"{s['temperature_c']} °C, vibration {s['vibration_mm_s']} mm/s, "
            f"pressure {s['pressure_bar']} bar, {s['rpm']} rpm")


def scripted_reply(kind: str, machine: dict, step: dict, total: int, message: str, finished: bool) -> str:
    if finished:
        return f"That's the last step. {machine['name']} is repaired and back online. Nice work."
    n = step["index"] + 1
    if kind in ("start", "advance"):
        lead = "Let's start." if kind == "start" else f"Good. Step {n} of {total}."
        text = f"{lead} {step['instruction']}"
        if step["safety_warning"]:
            text += f" Safety first: {step['safety_warning']}"
        return text
    q = message.lower()
    if any(w in q for w in ("safe", "danger", "risk", "warning")):
        return step["safety_warning"] or "No special hazard on this step, but keep lockout in place and wear PPE."
    if any(w in q for w in ("torque", "nm", "tight")):
        return f"Use the torque marked on the part for this step; for {step['title'].lower()} follow the values in the instruction. If none is given, use the manufacturer's spec."
    if any(w in q for w in ("temp", "hot", "sensor", "reading", "vibration", "pressure", "rpm")):
        return f"Live readings for {machine['name']}: {_sensors(machine)}."
    if any(w in q for w in ("tool", "need", "equipment")):
        return f"For this step, {step['instruction'].lower()} Have the standard hand tools and your PPE ready."
    if any(w in q for w in ("skip", "why", "must")):
        return "Don't skip steps: each one protects you or the machine. Tell me if something blocks you."
    return f"You're on step {n} of {total}: {step['title']}. {step['instruction']} Say 'done' when finished."


def build_system_prompt(machine: dict, step: dict, total: int, kind: str) -> str:
    fault = machine.get("fault") or {}
    return (
        "You are a concise AR repair copilot speaking to a technician on a factory floor. "
        "Reply in 1-3 short spoken sentences, no markdown.\n"
        f"Machine: {machine['name']} ({machine['id']}), status {machine['status']}, health {machine['health']:.0f}.\n"
        f"Live sensors: {_sensors(machine)}.\n"
        f"Fault: {fault.get('code')} - {fault.get('description')}.\n"
        f"Current step {step['index'] + 1} of {total}: {step['title']}. Instruction: {step['instruction']}. "
        f"Safety warning: {step['safety_warning'] or 'none'} (the system speaks it separately; do not repeat it).\n"
        + ("The technician just entered this step: tell them what to do. " if kind in ("start", "advance")
           else "Answer the technician's question about this step only. ")
        + "Never say the step is complete or move to another step; the system controls progress."
    )


def llm_reply(kind: str, machine: dict, step: dict, total: int, message: str, history: list[dict]):
    """Return (text, engine) from the provider chain, or None when no provider answers."""
    msgs: list[dict] = []
    for h in (history or [])[-6:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            if msgs and msgs[-1]["role"] == h["role"]:
                msgs[-1]["content"] += " " + h["content"]
            else:
                msgs.append({"role": h["role"], "content": h["content"]})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    if msgs and msgs[-1]["role"] == "user":
        msgs[-1]["content"] += " " + message
    else:
        msgs.append({"role": "user", "content": message})
    return llm.chat(build_system_prompt(machine, step, total, kind), msgs, max_tokens=200)


def handle(req: dict, machine: dict, proc: dict, on_guide, on_resolve) -> dict:
    """Process one copilot turn. on_guide/on_resolve are agent-loop hooks."""
    steps = proc["steps"]
    total = len(steps)
    idx = max(0, min(int(req["step_index"]), total - 1))
    kind = classify(req["message"])
    finished = False
    entered = False
    if kind == "start":
        on_guide(machine["id"])
        entered = True
    elif kind == "advance":
        if idx + 1 >= total:
            finished = True
        else:
            idx += 1
            entered = True
    step = steps[idx]

    res = None if finished else llm_reply(kind, machine, step, total, req["message"], req.get("history", []))
    text, engine = res if res else (None, llm.SCRIPTED_ENGINE)
    source = "llm" if text else "scripted"
    if text is None:
        text = scripted_reply(kind, machine, step, total, req["message"], finished)
    elif entered and step["safety_warning"] and step["safety_warning"].lower() not in text.lower():
        text += f" Safety: {step['safety_warning']}"  # code guarantees the warning is spoken exactly once
    if finished:
        on_resolve(machine["id"])
    return {"reply": text, "step": step, "total_steps": total, "done": finished, "source": source,
            "engine": engine}
