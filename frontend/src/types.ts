// Frontend mirror of docs/contracts/api.md v1.2. Shared contracts remain Lead-owned.
export type Status = 'ok' | 'warning' | 'fault';
export type Part = 'motor' | 'belt' | 'valve' | 'bearing' | 'panel' | 'spindle' | 'arm_joint' | 'hydraulic_line';
export interface Machine {
  id: string;
  name: string;
  type: 'cnc' | 'conveyor' | 'pump' | 'robot_arm' | 'press';
  position: { x: number; y: number; z: number };
  status: Status;
  health: number;
  criticality: number;
  sensors: { temperature_c: number; vibration_mm_s: number; pressure_bar: number; rpm: number };
  downtime_cost_per_hour: number;
  predicted_failure_min: number | null;
  fault: null | { code: string; description: string; part: Part; since: string };
}
export interface Kpis {
  active_faults: number;
  at_risk_usd_per_hour: number;
  repairs_completed: number;
  avg_mttr_min: number | null;
  downtime_cost_avoided_usd: number;
  technicians: { name: string; status: 'idle' | 'en_route' | 'repairing'; machine_id: string | null }[];
}
export interface AgentEvent {
  id: number;
  ts: string;
  kind: 'detect' | 'diagnose' | 'schedule' | 'dispatch' | 'guide' | 'resolve';
  machine_id: string | null;
  message: string;
}
export type TelemetryMessage = { type: 'telemetry'; ts: string; machines: Machine[]; kpis: Kpis };
export type StreamMessage = TelemetryMessage | { type: 'event'; event: AgentEvent };

export interface ScheduleItem {
  rank: number;
  machine_id: string;
  priority_score: number;
  reason: string;
  est_repair_min: number;
  technician: string;
}
export interface Schedule {
  generated_at: string;
  method: 'qubo-simulated-annealing';
  energy: number;
  baseline_cost: number;
  optimized_cost: number;
  savings_usd: number;
  queue: ScheduleItem[];
}
export interface ProcedureStep {
  index: number;
  title: string;
  instruction: string;
  part: Part;
  safety_warning: string | null;
}
export interface CopilotRequest {
  machine_id: string;
  message: string;
  step_index: number;
  history: { role: 'user' | 'assistant'; content: string }[];
}
export interface CopilotResponse {
  reply: string;
  step: ProcedureStep;
  total_steps: number;
  done: boolean;
  source: 'llm' | 'scripted';
  engine: string;
}
export interface ApiHealth {
  ok: boolean;
  ai: { provider: 'qualcomm' | 'anthropic' | 'scripted'; model: string | null; engine: string };
}
