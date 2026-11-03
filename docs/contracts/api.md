# API contract (v1): backend ⇄ frontend

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
  baseline_cost: number;      // weighted downtime cost of the naive greedy order
  optimized_cost: number;     // weighted downtime cost of the annealed order
  queue: ScheduleItem[];      // only machines with status != "ok"
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
}
```

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ "ok": true }` |
| GET | `/api/machines` | `Machine[]` |
| GET | `/api/machines/{id}` | `Machine` (404 if unknown) |
| WS | `/ws/telemetry` | every 1 s: `{ "type": "telemetry", "ts": string, "machines": Machine[] }` |
| GET | `/api/schedule` | `Schedule` (latest) |
| POST | `/api/schedule/recompute` | `Schedule` (runs the annealer now) |
| GET | `/api/procedures/{fault_code}` | `{ "fault_code": string, "title": string, "steps": ProcedureStep[] }` |
| POST | `/api/copilot` | body `CopilotRequest` → `CopilotResponse` |
| POST | `/api/demo/inject-fault` | body `{ "machine_id": string, "code": string }` → `Machine`. Forces a fault for the live demo. |

## Copilot step logic

- `message` is "start": return step `step_index`.
- `message` is "done", "next" or "ok": advance to `step_index + 1`. If that was the last step, set `done: true`, and the backend marks the machine `ok`, health 95.
- Any other message is a question. Answer it about the **current** step and do not advance.
- Every reply includes the step's `safety_warning` when it's non-null and the step was just entered.
