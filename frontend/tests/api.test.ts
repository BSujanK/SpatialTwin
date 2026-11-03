import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const machines = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8'));
const kpis = JSON.parse(readFileSync(new URL('../../shared/mock/kpis.json', import.meta.url), 'utf8'));
const eventsFixture = JSON.parse(readFileSync(new URL('../../shared/mock/events.json', import.meta.url), 'utf8'));
const scheduleFixture = JSON.parse(readFileSync(new URL('../../shared/mock/schedule.json', import.meta.url), 'utf8'));
const controlFixture = JSON.parse(readFileSync(new URL('../../shared/mock/control_actions.json', import.meta.url), 'utf8'));

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
  const controls: unknown[] = [];
  const stop = api.subscribeTelemetry({
    connection: (state: string) => states.push(state),
    machines: (value: unknown) => snapshots.push(value),
    message: (value: unknown) => events.push(value),
    control: (value: unknown) => controls.push(value),
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
  const control = { ...controlFixture[0], rationale: 'Async explanation arrived' };
  socket.onmessage?.({ data: JSON.stringify({ type: 'control', action: control }) });
  assert.deepEqual(controls, [control]);
  assert.equal(events.length, 3);
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
  assert.deepEqual(await api.recomputeSchedule(), scheduleFixture);
  const controlApi = await vite.ssrLoadModule('/src/control-api.ts');
  assert.deepEqual(await controlApi.getControlActions(), controlFixture);
  const originalPolicy = await controlApi.getControlPolicy();
  assert.deepEqual(await controlApi.updateControlPolicy({ autonomy: 'auto' }), { ...originalPolicy, autonomy: 'auto' });
  const proposed = controlFixture.find((action: { status: string }) => action.status === 'proposed');
  assert.equal((await controlApi.commandControlAction(proposed.id, 'approve')).status, 'active');
  assert.equal((await controlApi.commandControlAction(proposed.id, 'revert')).status, 'reverted');
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
  const fetchMock = t.mock.method(globalThis, 'fetch', (path: string) => new Promise<Response>(resolve => pending.set(path, resolve)));
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
  const schedules: unknown[] = [];
  cleanup = api.subscribeTelemetry({ machines() {}, connection() {}, events: (value: typeof history) => { history = value; }, kpis: (value: unknown) => readings.push(value), schedule: (value: unknown) => schedules.push(value) });
  const socket = Socket.instances[0];
  socket.onopen?.();
  const latest = { ...kpis, active_faults: 4, at_risk_usd_per_hour: 34000 };
  const nextId = Math.max(...eventsFixture.map((event: { id: number }) => event.id)) + 1;
  socket.emit({ type: 'telemetry', ts: '2026-11-03T05:00:00Z', machines, kpis: latest });
  socket.emit({ type: 'event', event: { ...eventsFixture[0], id: nextId } });
  pending.get('/api/events?limit=50')?.(new Response(JSON.stringify(eventsFixture)));
  pending.get('/api/kpis')?.(new Response(JSON.stringify(kpis)));
  pending.get('/api/schedule')?.(new Response(JSON.stringify(scheduleFixture)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(history.map(event => event.id), [...eventsFixture.map((event: { id: number }) => event.id), nextId].sort((a, b) => a - b));
  assert.deepEqual(readings, [latest]);
  socket.emit({ type: 'event', event: { ...eventsFixture[0], id: nextId } });
  assert.equal(history.length, eventsFixture.length + 1);
  assert.deepEqual(schedules, [scheduleFixture]);
  const scheduleRequests = () => fetchMock.mock.calls.filter(call => call.arguments[0] === '/api/schedule').length;
  const before = scheduleRequests();
  socket.emit({ type: 'event', event: { ...eventsFixture[0], id: nextId + 1, kind: 'schedule', machine_id: null } });
  assert.equal(scheduleRequests(), before + 1, 'every schedule event refreshes the queue');
  const updated = { ...scheduleFixture, queue: [] };
  pending.get('/api/schedule')?.(new Response(JSON.stringify(updated)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(schedules.at(-1), updated);
  const recompute = api.recomputeSchedule();
  const post = fetchMock.mock.calls.find(call => call.arguments[0] === '/api/schedule/recompute');
  assert.equal((post?.arguments[1] as RequestInit).method, 'POST');
  pending.get('/api/schedule/recompute')?.(new Response(JSON.stringify(scheduleFixture)));
  assert.deepEqual(await recompute, scheduleFixture);
  socket.close();
  [...timers.values()].find(timer => timer.delay === 1000)?.callback();
  Socket.instances[1].onopen?.();
  pending.get('/api/events?limit=50')?.(new Response(JSON.stringify([eventsFixture[0]])));
  pending.get('/api/kpis')?.(new Response(JSON.stringify(kpis)));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(history.map(event => event.id), [1], 'reconnect replaces old history after a reset');
});
