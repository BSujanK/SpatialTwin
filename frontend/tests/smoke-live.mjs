// Run against a local live Vite server and backend; no browser or API key required.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const origin = process.argv[2] || 'http://localhost:5173';
process.env.VITE_USE_MOCK = 'false';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (path, options) => nativeFetch(new URL(path, origin), options);
globalThis.window = {
  location: { origin },
  setTimeout, clearTimeout,
};
let stop = () => {};
const vite = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' });
try {
  const health = await (await fetch('/api/health')).json();
  assert.equal(health.ok, true, 'REST proxy health check');
  const api = await vite.ssrLoadModule('/src/api.ts');
  await new Promise((resolve, reject) => {
    let frames = 0;
    let previousTime;
    const timeout = setTimeout(() => reject(new Error('No live telemetry within 10 seconds')), 10000);
    stop = api.subscribeTelemetry({
      connection(state) { console.log(`Connection: ${state}`); },
      machines(machines) {
        assert.equal(machines.length, 5);
        assert.ok(machines.every(machine => typeof machine.health === 'number'));
      },
      message(message) {
        if (message.type !== 'telemetry') return;
        try {
          assert.equal(message.machines.length, 5);
          assert.ok(message.kpis.technicians.length > 0);
          // The initial snapshot and the first tick may share a second-resolution timestamp.
          if (message.ts === previousTime) return;
          previousTime = message.ts;
          if (++frames === 2) {
            clearTimeout(timeout);
            console.log('PASS: REST proxy and two successive websocket telemetry/KPI frames through the frontend data layer.');
            resolve();
          }
        } catch (error) { clearTimeout(timeout); reject(error); }
      },
    });
  });
} finally {
  stop();
  await vite.close();
  globalThis.fetch = nativeFetch;
  delete globalThis.window;
}
