import machinesFixture from '../../shared/mock/machines.json';
import kpisFixture from '../../shared/mock/kpis.json';
import eventsFixture from '../../shared/mock/events.json';
import scheduleFixture from '../../shared/mock/schedule.json';
import { jitterMachines, mergeEvents, websocketUrl } from './data';
import type { AgentEvent, Kpis, Machine, Schedule, StreamMessage } from './types';

export const useMock = import.meta.env.VITE_USE_MOCK === 'true';
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'mock';

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

export const getEvents = (signal?: AbortSignal): Promise<AgentEvent[]> => useMock
  ? Promise.resolve(structuredClone(eventsFixture) as AgentEvent[])
  : request('/api/events?limit=50', { signal });
export const getKpis = (signal?: AbortSignal): Promise<Kpis> => useMock
  ? Promise.resolve(structuredClone(kpisFixture) as Kpis)
  : request('/api/kpis', { signal });
export const getSchedule = (signal?: AbortSignal): Promise<Schedule> => useMock
  ? Promise.resolve(structuredClone(scheduleFixture) as Schedule)
  : request('/api/schedule', { signal });
export const recomputeSchedule = (): Promise<Schedule> => useMock
  ? getSchedule()
  : request('/api/schedule/recompute', { method: 'POST' });

export function subscribeTelemetry(handlers: {
  machines: (machines: Machine[], ts: string) => void;
  message?: (message: StreamMessage) => void;
  connection: (state: ConnectionState) => void;
  kpis?: (kpis: Kpis) => void;
  events?: (events: AgentEvent[]) => void;
  schedule?: (schedule: Schedule) => void;
  impactError?: (message: string | null) => void;
}): () => void {
  if (useMock) {
    const machines: Machine[] = structuredClone(machinesFixture) as Machine[];
    const startedAt = Date.now();
    const emit = (jitter: boolean) => {
      const message: StreamMessage = { type: 'telemetry', ts: new Date().toISOString(), machines: jitter ? jitterMachines(machines) : structuredClone(machines), kpis: structuredClone(kpisFixture) as Kpis };
      for (const machine of message.machines) {
        if (jitter && machine.predicted_failure_min !== null) machine.predicted_failure_min = Math.max(0, machine.predicted_failure_min - (Date.now() - startedAt) / 60000);
      }
      handlers.machines(message.machines, message.ts);
      handlers.kpis?.(message.kpis);
      handlers.message?.(message);
    };
    handlers.connection('mock');
    handlers.events?.(structuredClone(eventsFixture) as AgentEvent[]);
    handlers.schedule?.(structuredClone(scheduleFixture) as Schedule);
    emit(false);
    const timer = window.setInterval(() => emit(true), 1000);
    return () => window.clearInterval(timer);
  }

  let stopped = false;
  let socket: WebSocket | undefined;
  let retryTimer: number | undefined;
  let watchdog: number | undefined;
  let attempt = 0;
  let receivedTelemetry = false;
  let telemetryVersion = 0;
  let impactVersion = 0;
  let scheduleVersion = 0;
  let eventHistory: AgentEvent[] = [];
  let pendingEvents: AgentEvent[] | null = null;
  const initial = new AbortController();
  const signal = () => AbortSignal.any([initial.signal, AbortSignal.timeout(8000)]);
  const refreshSchedule = async () => {
    if (!handlers.schedule) return;
    const version = ++scheduleVersion;
    try {
      const schedule = await getSchedule(signal());
      if (!stopped && version === scheduleVersion) handlers.schedule(schedule);
    } catch { if (!stopped) handlers.impactError?.('Schedule unavailable; retry on reconnect.'); }
  };
  const refreshImpact = async () => {
    const version = ++impactVersion;
    const telemetryAtStart = telemetryVersion;
    pendingEvents = [];
    // Subscribe first, then merge events received while the REST snapshot is in flight.
    const results = await Promise.allSettled([
      handlers.events ? getEvents(signal()) : Promise.resolve(null),
      handlers.kpis ? getKpis(signal()) : Promise.resolve(null),
    ]);
    if (stopped || version !== impactVersion) return;
    const [history, kpis] = results;
    if (history.status === 'fulfilled' && history.value) {
      eventHistory = mergeEvents(history.value, pendingEvents ?? []);
      handlers.events?.(eventHistory);
    }
    pendingEvents = null;
    if (kpis.status === 'fulfilled' && kpis.value && telemetryAtStart === telemetryVersion) handlers.kpis?.(kpis.value);
    handlers.impactError?.(results.some(result => result.status === 'rejected') ? 'Impact history unavailable; live updates continue. Reconnect to retry.' : null);
  };
  // The REST snapshot renders while the websocket is connecting. Never overwrite newer telemetry.
  void request<Machine[]>('/api/machines', { signal: AbortSignal.any([initial.signal, AbortSignal.timeout(8000)]) })
    .then(machines => { if (!stopped && !receivedTelemetry) handlers.machines(machines, new Date().toISOString()); })
    .catch(() => { /* Websocket retries remain active; the connection badge makes failure visible. */ });

  const connect = () => {
    if (stopped) return;
    handlers.connection(attempt ? 'reconnecting' : 'connecting');
    socket = new WebSocket(websocketUrl(window.location.origin));
    const active = socket;
    active.onopen = () => {
      if (stopped || socket !== active) return;
      void refreshImpact();
      void refreshSchedule();
    };
    const armWatchdog = () => {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => active.close(), 6000);
    };
    armWatchdog();
    active.onmessage = ({ data }) => {
      if (stopped || socket !== active) return;
      try {
        const message = JSON.parse(data) as StreamMessage;
        if (message.type !== 'telemetry' && message.type !== 'event') return;
        if (message.type === 'telemetry') {
          if (!Array.isArray(message.machines) || typeof message.ts !== 'string') return;
          receivedTelemetry = true;
          telemetryVersion++;
          attempt = 0;
          handlers.connection('live');
          handlers.machines(message.machines, message.ts);
          handlers.kpis?.(message.kpis);
          armWatchdog();
        } else {
          const event = message.event;
          if (!event || !Number.isInteger(event.id) || typeof event.message !== 'string') return;
          pendingEvents?.push(event);
          eventHistory = mergeEvents(eventHistory, [event]);
          handlers.events?.(eventHistory);
          if (event.kind === 'schedule' || event.kind === 'resolve') void refreshSchedule();
        }
        handlers.message?.(message);
      } catch { /* Ignore malformed frames without killing reconnection. */ }
    };
    active.onerror = () => active.close();
    active.onclose = () => {
      if (stopped) return;
      window.clearTimeout(watchdog);
      handlers.connection('reconnecting');
      retryTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempt++, 10000));
    };
  };
  connect();
  return () => {
    stopped = true;
    initial.abort();
    window.clearTimeout(retryTimer);
    window.clearTimeout(watchdog);
    socket?.close();
  };
}
