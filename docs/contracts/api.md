# API contract (v1.2): backend ⇄ frontend

The backend is FastAPI on `http://localhost:8000`. CORS allows all origins. All JSON uses snake_case.
Example payloads live in `shared/mock/` and must stay valid against this document.

## Types

```ts
type Status = "ok" | "warning" | "fault";
type Part = "motor" | "belt" | "valve" | "bearing" | "panel" | "spindle" | "arm_joint" | "hydraulic_line";

interface Machine {
  id: string;                 // "CNC-01", "CONV-02", "PUMP-03", "ROBOT-04", "PRESS-05"
  name: string;               // "CNC Mill"
  type: "cnc" | "conveyor" | "pump" | "robot_arm" | "press";
  position: { x: number; y: number; z: number };  // metres on the floor plan, y = up (always 0)
  status: Status;
  health: number;             // 0–100, lower = worse
  criticality: number;        // 1–5, how much production depends on it
  sensors: {
    temperature_c: number;
    vibration_mm_s: number;
    pressure_bar: number;
    rpm: number;
  };
  downtime_cost_per_hour: number;   // USD lost per hour this machine is down (v1.1)
  predicted_failure_min: number | null; // minutes until health hits 0 at the current trend; null if ok or improving (v1.1)
  fault: null | {
    code: string;             // e.g. "BRG-OVERHEAT"
    description: string;
    part: Part;               // part to highlight in AR
    since: string;            // ISO-8601
  };
}

interface ScheduleItem {
  rank: number;               // 1 = fix first
  machine_id: string;
  priority_score: number;     // 0–1
  reason: string;             // one human sentence
  est_repair_min: number;
  technician: string;         // "Tech A" | "Tech B"
}

interface Schedule {
  generated_at: string;       // ISO-8601
  method: "qubo-simulated-annealing";
  energy: number;             // final QUBO energy (lower = better)
  baseline_cost: number;      // expected USD downtime loss of the naive greedy order (sort by health)
  optimized_cost: number;     // expected USD downtime loss of the annealed order
  savings_usd: number;        // baseline_cost - optimized_cost (v1.1)
  queue: ScheduleItem[];      // only machines with status != "ok"
}
// Expected loss per machine = downtime_cost_per_hour × (wait_min + est_repair_min) / 60
//   × failure_risk, where failure_risk is higher when predicted_failure_min is small.
// Two technicians work in parallel; wait_min is the sum of repair times queued ahead on that technician.

// v1.1: the autonomous agent loop. Every decision the agent makes is logged as an event.
interface AgentEvent {
  id: number;                 // increasing
  ts: string;                 // ISO-8601
  kind: "detect" | "diagnose" | "schedule" | "dispatch" | "guide" | "resolve";
  machine_id: string | null;
  message: string;            // one human sentence, shown in the activity feed
}

interface Kpis {
  active_faults: number;                // machines with status != "ok"
  at_risk_usd_per_hour: number;         // sum of downtime_cost_per_hour over non-ok machines
  repairs_completed: number;
  avg_mttr_min: number | null;          // mean time from detect to resolve
  downtime_cost_avoided_usd: number;    // running sum of schedule savings_usd at each re-optimization that changed the order
  technicians: { name: string; status: "idle" | "en_route" | "repairing"; machine_id: string | null }[];
}

interface ProcedureStep {
  index: number;              // 0-based
  title: string;
  instruction: string;
  part: Part;                 // part to highlight for this step
  safety_warning: string | null;
}

interface CopilotRequest {
  machine_id: string;
  message: string;            // technician's words, e.g. "start", "done", "what torque?"
  step_index: number;         // step the technician is currently on (0 when starting)
  history: { role: "user" | "assistant"; content: string }[];
}

interface CopilotResponse {
  reply: string;              // what the copilot says (1–3 sentences, spoken style)
  step: ProcedureStep;        // step to show now
  total_steps: number;
  done: boolean;              // true when the procedure is finished
  source: "llm" | "scripted"; // which engine answered
  engine: string;             // v1.2: human label, e.g. "Qualcomm Cloud AI 100 · Llama-3.1-8B" or "Scripted fallback"
}
```

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ "ok": true, "ai": { "provider": "qualcomm" \| "anthropic" \| "scripted", "model": string \| null, "engine": string } }` (v1.2) |
| GET | `/api/machines` | `Machine[]` |
| GET | `/api/machines/{id}` | `Machine` (404 if unknown) |
| WS | `/ws/telemetry` | every 1 s: `{ "type": "telemetry", "ts": string, "machines": Machine[], "kpis": Kpis }`. Also, immediately when an event happens: `{ "type": "event", "event": AgentEvent }` |
| GET | `/api/events?limit=50` | `AgentEvent[]`, newest last (v1.1) |
| GET | `/api/kpis` | `Kpis` (v1.1) |
| GET | `/api/schedule` | `Schedule` (latest) |
| POST | `/api/schedule/recompute` | `Schedule` (runs the annealer now) |
| GET | `/api/procedures` | `{ "fault_code": string, "title": string }[]` (all procedures; drives the Inject fault dropdown) |
| GET | `/api/procedures/{fault_code}` | `{ "fault_code": string, "title": string, "steps": ProcedureStep[] }` |
| POST | `/api/copilot` | body `CopilotRequest` → `CopilotResponse` |
| POST | `/api/demo/reset` | `{ "ok": true }`. Restores the starting scenario (machines, events, KPIs, technicians) for a fresh demo run. Frontend: add a small "Reset demo" button next to Inject fault. |
| POST | `/api/demo/inject-fault` | body `{ "machine_id": string, "code": string }` → `Machine`. Forces a fault for the live demo. Valid codes: BRG-OVERHEAT, BELT-SLIP, HYD-LEAK, SPINDLE-VIB, JOINT-STALL. |

## Copilot step logic

- `message` is "start": return step `step_index`.
- `message` is "done", "next" or "ok": advance to `step_index + 1`. If that was the last step, set `done: true`, and the backend marks the machine `ok`, health 95.
- Any other message is a question. Answer it about the **current** step and do not advance.
- Every reply includes the step's `safety_warning` when it's non-null and the step was just entered.

## Autonomous agent loop (v1.1)

The backend runs this loop with no human input. Each arrow emits an `AgentEvent`:
1. **detect**: a machine's status worsens (ok→warning, warning→fault), or a fault is injected.
2. **diagnose**: map the fault to its code and procedure, and estimate `predicted_failure_min`.
3. **schedule**: re-run the QUBO annealer and report the new order and `savings_usd`.
4. **dispatch**: assign the top idle technician to the top queued machine, with a work order `WO-<n>`. That technician's status becomes `en_route`.
5. **guide**: the first copilot "start" on that machine sets the technician to `repairing`.
6. **resolve**: the last copilot step completes. The machine goes back to ok, the technician to idle, MTTR is recorded, and the agent dispatches the next item.

## Qualcomm Cloud AI 100 (v1.2): hackathon requirement

The AI brain runs on **Qualcomm Cloud AI 100** through the Qualcomm AI Inference Suite / Cirrascale Cloud AI Playground (OpenAI-compatible API).
- Env: `QUALCOMM_API_KEY` (never committed), `QUALCOMM_ENDPOINT` (default `https://aisuite.cirrascale.com/apis/v2`), `QUALCOMM_MODEL` (default: the best available chat LLM from the model list).
- Provider order: Qualcomm → Anthropic (only if `ANTHROPIC_API_KEY` is set) → scripted. Any error or timeout (8 s) falls through to the next provider.
- Used in two places:
  1. **Copilot replies** (`/api/copilot`). Step logic stays in code.
  2. **AI root-cause analysis** in the agent loop. After each `diagnose` event, a background call (it never blocks the loop) asks the LLM for a one-sentence likely root cause and recommended action from the live sensors. It's emitted as an extra `diagnose` event with the message prefix `"Qualcomm Cloud AI 100: "`. On failure nothing is emitted.
