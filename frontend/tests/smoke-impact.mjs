// Opt-in local demo integration check: resets the scenario before and after injecting a fault.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const origin = process.argv[2] || 'http://localhost:5173';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'Use a local demo instance');
process.env.VITE_USE_MOCK = 'false';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (path, options) => nativeFetch(new URL(path, origin), options);
globalThis.window = { location: { origin }, setTimeout, clearTimeout };
const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
const api = await vite.ssrLoadModule('/src/api.ts');
let stop = () => {};
const until = async condition => {
  const deadline = performance.now() + 10000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for impact update');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
try {
  await api.request('/api/demo/reset', { method: 'POST' });
  let kpis;
  let history;
  let schedule;
  let connected = false;
  let start = 0;
  let eventMs;
  let kpiMs;
  let baselineId = 0;
  stop = api.subscribeTelemetry({
    machines() {},
    connection(state) { connected = state === 'live'; },
    kpis(value) {
      kpis = value;
      if (start && value.active_faults === 4 && value.at_risk_usd_per_hour === 34000 && kpiMs === undefined) kpiMs = performance.now() - start;
    },
    events(value) {
      history = value;
      if (start && value.some(event => event.id > baselineId && event.machine_id === 'CNC-01' && event.kind === 'detect') && eventMs === undefined) eventMs = performance.now() - start;
    },
    schedule(value) { schedule = value; },
  });
  await until(() => connected && kpis && history && schedule);
  assert.equal(kpis.at_risk_usd_per_hour, 30000);
  baselineId = history.at(-1)?.id ?? 0;
  start = performance.now();
  await api.request('/api/demo/inject-fault', { method: 'POST', body: JSON.stringify({ machine_id: 'CNC-01', code: 'SPINDLE-VIB' }) });
  await until(() => eventMs !== undefined && kpiMs !== undefined && schedule.queue.some(item => item.machine_id === 'CNC-01'));
  const kinds = new Set(history.filter(event => event.id > baselineId).map(event => event.kind));
  for (const kind of ['detect', 'diagnose', 'schedule', 'dispatch']) assert.ok(kinds.has(kind), `Missing ${kind} event`);
  assert.ok(eventMs < 1000, `Event latency ${eventMs.toFixed(0)} ms`);
  assert.ok(kpiMs < 1100, `KPI latency ${kpiMs.toFixed(0)} ms (1 s backend tick + transport margin)`);
  console.log(`PASS: detect/diagnose/schedule/dispatch, risk $30,000 → $34,000, 4 active faults, updated ranks. Event ${eventMs.toFixed(0)} ms; KPI ${kpiMs.toFixed(0)} ms.`);
} finally {
  stop();
  await api.request('/api/demo/reset', { method: 'POST' });
  await vite.close();
  globalThis.fetch = nativeFetch;
  delete globalThis.window;
}
