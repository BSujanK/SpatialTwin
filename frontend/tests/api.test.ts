import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const machines = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8'));
const kpis = JSON.parse(readFileSync(new URL('../../shared/mock/kpis.json', import.meta.url), 'utf8'));
const eventsFixture = JSON.parse(readFileSync(new URL('../../shared/mock/events.json', import.meta.url), 'utf8'));
const scheduleFixture = JSON.parse(readFileSync(new URL('../../shared/mock/schedule.json', import.meta.url), 'utf8'));

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

test('mock subscription starts from shared fixtures and ticks without network access', async t => {
  const previousMode = process.env.VITE_USE_MOCK;
  process.env.VITE_USE_MOCK = 'true';
  let tick: (() => void) | undefined;
  let cleared = false;
  let cleanup = () => {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setInterval(callback: () => void, delay: number) { assert.equal(delay, 1000); tick = callback; return 1; },
    clearInterval() { cleared = true; },
  } });
  t.after(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, 'window');
    if (previousMode === undefined) delete process.env.VITE_USE_MOCK;
    else process.env.VITE_USE_MOCK = previousMode;
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Mock mode must not fetch'); });
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => vite.close());
  const api = await vite.ssrLoadModule('/src/api.ts');
  const snapshots: unknown[] = [];
  cleanup = api.subscribeTelemetry({
    connection: (state: string) => assert.equal(state, 'mock'),
    machines: (snapshot: unknown) => snapshots.push(snapshot),
    message: (message: { kpis: unknown }) => assert.deepEqual(message.kpis, kpis),
    events: (events: unknown) => assert.deepEqual(events, eventsFixture),
    schedule: (schedule: unknown) => assert.deepEqual(schedule, scheduleFixture),
  });
  assert.deepEqual(await api.getEvents(), eventsFixture);
  assert.deepEqual(await api.getSchedule(), scheduleFixture);
  assert.deepEqual(snapshots[0], machines);
  tick?.();
  assert.equal(snapshots.length, 2);
  assert.equal(fetchMock.mock.callCount(), 0);
  cleanup();
  assert.equal(cleared, true);
});

test('impact hydration merges concurrent events, ignores stale KPIs, and refreshes on reconnect', async t => {
  const previousMode = process.env.VITE_USE_MOCK;
  process.env.VITE_USE_MOCK = 'false';
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  let cleanup = () => {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'http://factory.example' },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
  } });
  t.after(() => {
    cleanup();
    Reflect.deleteProperty(globalThis, 'window');
    if (previousMode === undefined) delete process.env.VITE_USE_MOCK;
    else process.env.VITE_USE_MOCK = previousMode;
  });
  const pending = new Map<string, (value: Response) => void>();
  t.mock.method(globalThis, 'fetch', (path: string) => new Promise<Response>(resolve => pending.set(path, resolve)));
  class Socket {
    static instances: Socket[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() { Socket.instances.push(this); }
    close() { this.onclose?.(); }
    emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  const original = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  t.after(() => { globalThis.WebSocket = original; });
  const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
  t.after(() => vite.close());
  const api = await vite.ssrLoadModule('/src/api.ts');
  let history: { id: number }[] = [];
  const readings: unknown[] = [];
  cleanup = api.subscribeTelemetry({ machines() {}, connection() {}, events: (value: typeof history) => { history = value; }, kpis: (value: unknown) => readings.push(value) });
  const socket = Socket.instances[0];
  socket.onopen?.();
  const latest = { ...kpis, active_faults: 4, at_risk_usd_per_hour: 34000 };
  socket.emit({ type: 'telemetry', ts: '2026-11-03T05:00:00Z', machines, kpis: latest });
  socket.emit({ type: 'event', event: { ...eventsFixture[0], id: 6 } });
  pending.get('/api/events?limit=50')?.(new Response(JSON.stringify(eventsFixture)));
  pending.get('/api/kpis')?.(new Response(JSON.stringify(kpis)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(history.map(event => event.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(readings, [latest]);
  socket.emit({ type: 'event', event: { ...eventsFixture[0], id: 6 } });
  assert.equal(history.length, 6);
  socket.close();
  [...timers.values()].find(timer => timer.delay === 1000)?.callback();
  Socket.instances[1].onopen?.();
  pending.get('/api/events?limit=50')?.(new Response(JSON.stringify([eventsFixture[0]])));
  pending.get('/api/kpis')?.(new Response(JSON.stringify(kpis)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(history.map(event => event.id), [1], 'reconnect replaces old history after a reset');
});
