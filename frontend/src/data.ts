import type { AgentEvent, Machine } from './types.ts';

export function jitterMachines(machines: Machine[], random = Math.random): Machine[] {
  // Bounded around the fixture, rather than accumulating a random walk.
  const jitter = (value: number, amplitude: number) => value === 0 ? 0 : Math.max(0, value + (random() - 0.5) * amplitude);
  return machines.map(machine => ({
    ...machine,
    sensors: {
      temperature_c: jitter(machine.sensors.temperature_c, 0.8),
      vibration_mm_s: jitter(machine.sensors.vibration_mm_s, 0.2),
      pressure_bar: jitter(machine.sensors.pressure_bar, 0.4),
      rpm: Math.round(jitter(machine.sensors.rpm, 8)),
    },
  }));
}

export function websocketUrl(base: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/telemetry`;
  return url.toString();
}

export function mergeEvents(snapshot: AgentEvent[], incoming: AgentEvent[], limit = 50): AgentEvent[] {
  const events = new Map(snapshot.map(event => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()].sort((a, b) => a.id - b.id).slice(-limit);
}

export function failureCountdown(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return minutes <= 0 ? 'failure imminent' : `fails in ${Math.ceil(minutes)} min`;
}
