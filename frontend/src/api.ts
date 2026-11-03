import machinesFixture from '../../shared/mock/machines.json';
import kpisFixture from '../../shared/mock/kpis.json';
import { jitterMachines, websocketUrl } from './data';
import type { Kpis, Machine, StreamMessage } from './types';

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

export function subscribeTelemetry(handlers: {
  machines: (machines: Machine[], ts: string) => void;
  message?: (message: StreamMessage) => void;
  connection: (state: ConnectionState) => void;
}): () => void {
  if (useMock) {
    const machines: Machine[] = structuredClone(machinesFixture) as Machine[];
    const emit = (jitter: boolean) => {
      const message: StreamMessage = { type: 'telemetry', ts: new Date().toISOString(), machines: jitter ? jitterMachines(machines) : structuredClone(machines), kpis: structuredClone(kpisFixture) as Kpis };
      handlers.machines(message.machines, message.ts);
      handlers.message?.(message);
    };
    handlers.connection('mock');
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
  const initial = new AbortController();
  // The REST snapshot renders while the websocket is connecting. Never overwrite newer telemetry.
  void request<Machine[]>('/api/machines', { signal: AbortSignal.any([initial.signal, AbortSignal.timeout(8000)]) })
    .then(machines => { if (!stopped && !receivedTelemetry) handlers.machines(machines, new Date().toISOString()); })
    .catch(() => { /* Websocket retries remain active; the connection badge makes failure visible. */ });

  const connect = () => {
    if (stopped) return;
    handlers.connection(attempt ? 'reconnecting' : 'connecting');
    socket = new WebSocket(websocketUrl(window.location.origin));
    const active = socket;
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
          attempt = 0;
          handlers.connection('live');
          handlers.machines(message.machines, message.ts);
          armWatchdog();
        }
        handlers.message?.(message);
      } catch { /* Ignore malformed frames without killing reconnection. */ }
    };
    active.onerror = () => active.close();
    active.onclose = () => {
      window.clearTimeout(watchdog);
      if (stopped) return;
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
