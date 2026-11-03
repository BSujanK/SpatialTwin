// Frontend mirror of docs/contracts/api.md v1.3. Shared contracts remain Lead-owned.
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
  control: { mode: 'nominal' | 'mitigated' | 'safe_stop'; setpoints: Setpoints; action_id: string | null };
  fault: null | { code: string; description: string; part: Part; since: string };
}
export interface Kpis {
  active_faults: number;
  at_risk_usd_per_hour: number;
  repairs_completed: number;
  avg_mttr_min: number | null;
  downtime_cost_avoided_usd: number;
  mitigations_active: number;
  failures_prevented: number;
  ttf_extended_min: number;
  throughput_cost_usd_per_hour: number;
  technicians: { name: string; status: 'idle' | 'en_route' | 'repairing'; machine_id: string | null }[];
}
export interface AgentEvent {
  id: number;
  ts: string;
  kind: 'detect' | 'diagnose' | 'schedule' | 'dispatch' | 'guide' | 'resolve' | 'mitigate' | 'escalate' | 'restore';
  machine_id: string | null;
  message: string;
}
export type TelemetryMessage = { type: 'telemetry'; ts: string; machines: Machine[]; kpis: Kpis };
export type StreamMessage = TelemetryMessage | { type: 'event'; event: AgentEvent } | { type: 'control'; action: ControlAction };

export interface Setpoints { speed_pct: number; load_pct: number; coolant_pct: number }
export type Autonomy = 'advise' | 'approve' | 'auto';
export type ControlKind = 'derate_speed' | 'reduce_load' | 'boost_cooling' | 'reduce_pressure' | 'limit_velocity' | 'controlled_stop' | 'restore_nominal';
export interface ControlPolicy {
  autonomy: Autonomy;
  enabled: boolean;
  max_derate_pct: number;
  allow_controlled_stop: boolean;
}
export interface ControlAction {
  id: string;
  machine_id: string;
  created_at: string;
  kinds: ControlKind[];
  label: string;
  setpoints: Setpoints;
  previous_setpoints: Setpoints;
  status: 'proposed' | 'active' | 'rejected' | 'reverted' | 'completed' | 'escalated';
  autonomy: Autonomy;
  reason: string;
  rationale: string | null;
  rationale_engine: string | null;
  ttf_before_min: number | null;
  ttf_after_min: number | null;
  throughput_cost_usd_per_hour: number;
  expected_loss_avoided_usd: number;
}

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
