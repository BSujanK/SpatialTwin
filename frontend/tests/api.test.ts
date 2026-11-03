import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const machines = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8'));
const kpis = JSON.parse(readFileSync(new URL('../../shared/mock/kpis.json', import.meta.url), 'utf8'));

test('live stream survives malformed frames, ignores stale REST, reconnects and cleans up', async t => {
  const previousMode = process.env.VITE_USE_MOCK;
  process.env.VITE_USE_MOCK = 'false';
  t.after(() => {
    if (previousMode === undefined) delete process.env.VITE_USE_MOCK;
    else process.env.VITE_USE_MOCK = previousMode;
  });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'https://factory.example' },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  } });
  let cleanup = () => {};
  t.after(() => { cleanup(); Reflect.deleteProperty(globalThis, 'window'); });
  let deliverSnapshot: (response: Response) => void = () => {};
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { deliverSnapshot = resolve; }));
  class FakeSocket {
    static instances: FakeSocket[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    readonly url: string;
    constructor(url: string) { this.url = url; FakeSocket.instances.push(this); }
    close() { this.onclose?.(); }
  }
  const originalSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
  t.after(() => { globalThis.WebSocket = originalSocket; });
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => vite.close());
  const api = await vite.ssrLoadModule('/src/api.ts');
  const states: string[] = [];
  const snapshots: unknown[] = [];
  const events: unknown[] = [];
  const stop = api.subscribeTelemetry({
    connection: (state: string) => states.push(state),
    machines: (value: unknown) => snapshots.push(value),
    message: (value: unknown) => events.push(value),
  });
  cleanup = stop;
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://factory.example/ws/telemetry');
  socket.onmessage?.({ data: 'bad json' });
  socket.onmessage?.({ data: JSON.stringify({ type: 'telemetry', ts: '2026-11-03T05:00:00Z', machines, kpis }) });
  deliverSnapshot(new Response(JSON.stringify([])));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(snapshots.length, 1, 'late REST response must not erase telemetry');
  assert.equal(states.at(-1), 'live');
  socket.onmessage?.({ data: JSON.stringify({ type: 'event', event: { id: 6, kind: 'detect', machine_id: 'PUMP-03', ts: '2026-11-03T05:00:00Z', message: 'Fault detected' } }) });
  assert.equal(events.length, 2);
  socket.close();
  assert.equal(states.at(-1), 'reconnecting');
  const retry = [...timers.values()].find(timer => timer.delay === 1000);
  assert.ok(retry);
  retry.callback();
  assert.equal(FakeSocket.instances.length, 2);
  stop();
  const count = FakeSocket.instances.length;
  for (const timer of timers.values()) timer.callback();
  assert.equal(FakeSocket.instances.length, count, 'cleanup must prevent new connections');
});
