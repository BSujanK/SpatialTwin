# Design: Autonomous Control (closed-loop mitigation)

_Status: proposed by the Lead, 2026-11-03. Implements contract v1.3._

## 1. Why

Judges' feedback: today every SpatialTwin insight ends at a **human**. The AR copilot guides a technician, but the machine keeps degrading until someone arrives. In an autonomous, lights-out factory that gap is the expensive part. When the pump will seize in 18 minutes and both technicians are busy for 25, a guided repair comes too late.

**The new capability:** the agent feeds its insights straight into the machine's **control system** and changes how the asset runs *before* it fails. It derates the speed, cuts the load, boosts cooling, lowers the hydraulic pressure, or as a last resort brings it to a **planned controlled stop** instead of letting it fail catastrophically. The aim is to keep the asset alive until the technician arrives. The AR-guided repair stays as the permanent fix.

This turns SpatialTwin from *predictive* maintenance (we tell you) into **prescriptive, closed-loop** maintenance (we act, safely, and tell you why).

## 2. Goals / non-goals / anti-goals

**Goals**
- A deterministic **Control Policy Engine** that picks the mitigation with the lowest **expected USD loss**, in the same economic language as the scheduler.
- **Three autonomy levels**, switchable live: *Advise* (log a recommendation), *Approve* (one-click human approval), *Auto* (executes on its own inside a safety envelope).
- Visible effect: time to failure is extended ("fails in 18 → 61 min"), $ at risk drops, the scheduler re-plans, and the 3D twin shows the machine running slower.
- **Every action reversible**, audited and explained (Qualcomm Cloud AI 100 writes the plain-language rationale).
- On repair completion, setpoints are **restored to nominal** automatically.

**Non-goals (for this hackathon)**
- A real PLC/OPC UA connection. We build the adapter interface plus a simulated adapter; the OPC UA adapter is a documented stub.
- Learning control policies (RL). The policy is rule-based plus an economic optimisation, which keeps it explainable.

**Anti-goals (a failure even if it "works")**
- **The LLM sets a setpoint.** Never: the LLM only explains. Numbers come from the deterministic policy with hard bounds.
- An action outside the safety envelope, an action on a machine under lockout/tagout (a technician is repairing it), or an action that cannot be undone.
- A mitigation that costs more in lost throughput than the failure it prevents. The economics must be visible.

## 3. How it works

### 3.1 The extended loop
```
detect → diagnose → MITIGATE → schedule → dispatch → guide → resolve → RESTORE
                        ↑                                         |
                        └──────── watchdog: escalate if the trend doesn't improve
```

### 3.2 Mitigation catalogue (per fault)
Each action has target **setpoints** (`speed_pct`, `load_pct`, `coolant_pct`, all percentages of nominal), a **degradation-rate multiplier** (how much it slows health loss), and a **throughput cost** (the share of `downtime_cost_per_hour` lost while it's active).

| Fault | Action `kind` | Setpoints | Rate × | Throughput cost |
|---|---|---|---|---|
| BRG-OVERHEAT (pump) | `derate_speed` + `boost_cooling` | speed 70, coolant 100 | 0.30 | 30% |
| HYD-LEAK (press) | `reduce_pressure` | load 80, speed 60 | 0.40 | 40% |
| BELT-SLIP (conveyor) | `derate_speed` | speed 80 | 0.50 | 20% |
| SPINDLE-VIB (CNC) | `derate_speed` | speed 75, load 70 | 0.40 | 30% |
| JOINT-STALL (robot) | `limit_velocity` | speed 50, load 60 | 0.45 | 50% |
| any | `controlled_stop` | speed 0, load 0 | 0.00 | 100% |
| on resolve | `restore_nominal` | 100 / 100 / nominal | n/a | 0% |

Gentler variants (for example derate to 85%) are allowed. The engine evaluates the candidates and picks the cheapest in expected loss.

### 3.3 Decision rule (deterministic, economic)
For a machine `m` with a fault: `T` is the predicted time to failure (min), and `W + R` is the technician wait plus repair time from the current schedule (min).
- If `T > (W + R) × 1.5`, the machine survives until the repair, so **no action**. Advise mode may still log "monitoring".
- Otherwise, for each candidate action `a` (including "do nothing"):
  - `T_a = T / rate_a` (time to failure under the action)
  - `p_fail(a) = sigmoid(((W + R) − T_a) / 5)`, the chance it fails before the repair
  - `failure_cost = downtime_cost_per_hour × 4 h` (an unplanned failure means a 4 h outage plus collateral damage, vs. a planned repair)
  - `expected_loss(a) = p_fail(a) × failure_cost + throughput_cost_a × downtime_cost_per_hour × (W + R) / 60`
- Choose `argmin expected_loss`. Report `ttf_before_min`, `ttf_after_min`, `throughput_cost_usd_per_hour` and `expected_loss_avoided_usd = expected_loss(do_nothing) − expected_loss(a)`.
- If even the best action leaves `p_fail > 0.5` and `allow_controlled_stop` is set, choose `controlled_stop`. **A planned stop beats a catastrophic failure.**

### 3.4 Safety envelope (enforced in code, unit-tested)
- **Bounds:** speed and load never below `100 − max_derate_pct` (default 40), except `controlled_stop`. Coolant is at most 100.
- **Interlock:** no new action on a machine whose technician status is `repairing` (lockout/tagout). Any pending proposal is held, and the machine is restored at resolve.
- **Rate limit:** at most one new action per machine per 60 s (simulated time).
- **Watchdog:** 30 s after an action becomes `active`, if the health slope hasn't improved by at least 40%, **escalate** to the next stronger action (logged as an `escalate` event). Controlled stop is the last step.
- **Reversible:** every action has a `revert` that restores the previous setpoints. Human override is always available, whatever the autonomy level.
- **Audit:** every state change is an `AgentEvent` and a `control` websocket message.

### 3.5 Autonomy levels
| Level | Behaviour | Demo use |
|---|---|---|
| `advise` | Action created as `proposed`; nothing changes on the machine | "Shadow mode", for building trust |
| `approve` | `proposed` → operator clicks **Approve** → `active` | Default: human in the loop |
| `auto` | Executes immediately inside the envelope → `active` | The lights-out factory story |

### 3.6 Control adapter (path to real hardware)
`ControlAdapter.write_setpoints(machine_id, setpoints) -> Ack` with:
- `SimulatedAdapter`: applies the setpoints to the simulator (changes the degradation rate and sensor behaviour, e.g. rpm × speed_pct, temperature drift × rate).
- `OpcUaAdapter` (stub plus docs): maps `speed_pct` and the others to OPC UA node ids from a config file; writes through `asyncua`; reads back to confirm. The production notes cover IEC 62443 zones, a read-back check, and writes allowed only to setpoint nodes, never to safety PLCs.

### 3.7 Where Qualcomm Cloud AI 100 fits
After the engine decides, a background call (the same worker queue as root cause) asks Llama-3.3-70B on Cloud AI 100 for a **one-sentence operator rationale**, e.g. *"Derating the coolant pump to 70% cuts bearing heat build-up and buys about 43 minutes until Tech B arrives, for $900/h of throughput."* It's stored as `rationale`, with the engine label shown as a badge. If the call fails, the rationale stays `null` and the UI shows the deterministic `reason`.

### 3.8 Scheduler interaction
The mitigated `predicted_failure_min` feeds back into the QUBO scheduler, so the repair queue re-plans (a mitigated machine may drop in rank and free a technician for something more urgent). That's the full loop: **control buys time, and the scheduler spends it well**.

## 4. UI (dashboard)
- **"Autonomous control" panel** (sidebar tab next to "Repair priorities"):
  - an autonomy switch **Advise / Approve / Auto**
  - action cards showing the machine, the action label, a **TTF bar "18 → 61 min"**, the trade-off "**−$900/h throughput · avoids $X expected loss**", the ⚡ Qualcomm rationale, and buttons **Approve / Reject** (proposed) or **Revert** (active)
- **3D twin:** a mitigated machine gets a **blue status ring** and a "⚙ 70%" chip on its label. Moving parts (conveyor belt, spindle, pump shaft) animate at `speed_pct`. A controlled stop shows as grey and still.
- **HUD:** a new tile, **"Failures prevented · +N min TTF"**. "$ at risk" drops when a mitigation lands.
- **Feed:** new kinds ⚙️ `mitigate`, ⏫ `escalate` and ↩️ `restore`.

## 5. Demo moment (adds ~40 s)
1. Set autonomy to **Auto**. Inject **BRG-OVERHEAT on PUMP-03** while both technicians are busy.
2. The feed shows detect → diagnose → **⚙️ mitigate "Derate pump to 70% + coolant 100%: fails in 18 → 61 min, avoids $X"** with the ⚡ Qualcomm rationale. The pump visibly slows in 3D, the ring turns blue and $ at risk drops.
3. The scheduler re-plans, Tech B arrives, the AR repair runs and resolves, and **↩️ restore nominal**: the pump spins back up.
4. Switch to **Approve** and inject again. A card appears for one-click approval, showing the human-in-the-loop path.

## 6. Work split
| ID | Owner | Scope |
|---|---|---|
| L5 | Lead | This design, contract v1.3, mocks, review, integration, demo script ✅ |
| **B10** | Claude-2 | Control engine: catalogue, decision rule, envelope, adapter interface + SimulatedAdapter + OpcUaAdapter stub, simulator effect model |
| **B11** | Claude-2 | Agent-loop integration (mitigate/escalate/restore), watchdog, interlock, scheduler feedback, Qualcomm rationale, endpoints, KPIs, tests incl. soak |
| **F8** | Astra | Autonomous-control panel (autonomy switch, action cards, approve/reject/revert) |
| **F9** | Astra | Twin + HUD + feed: blue ring and ⚙ chip, speed-proportional animation, controlled-stop look, HUD tile, feed icons |

Build order: B10 ∥ F8 (against mocks) → B11 ∥ F9 → Lead integration test → demo rehearsal.

## 7. Acceptance criteria
- Unit tests: the envelope bounds are never violated (property-style over random inputs); no action under lockout; rate limit; watchdog escalation; `restore_nominal` on resolve; the decision rule picks controlled stop when nothing else works; the LLM never influences setpoints.
- Live: in Auto mode, inject BRG-OVERHEAT → within 2 s a `mitigate` event, an `active` action with ttf_after > ttf_before, the scheduler re-planned and the KPIs updated; the rationale arrives within ~6 s.
- UI: the autonomy switch round-trips through `PUT /api/control/policy`; Approve/Reject/Revert work; the mitigated look is visible on the projector.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Judges ask "would you really let AI drive a PLC?" | The LLM never sets values; there's a deterministic envelope, three autonomy levels (default Approve) and audit/revert, plus the IEC 62443 notes |
| Mitigation economics look arbitrary | Show the numbers on the card; it uses the same $ model as the scheduler |
| Two features fighting over a machine (repair vs control) | The lockout interlock, and restore on resolve |
