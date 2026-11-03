// Frontend mirror of docs/contracts/api.md v1.1. Shared contracts remain Lead-owned.
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
