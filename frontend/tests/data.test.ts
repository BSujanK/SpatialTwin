import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jitterMachines, websocketUrl } from '../src/data.ts';
import type { Machine } from '../src/types.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8')) as Machine[];
test('jitter preserves fixtures, status, and zero sensors; bounds all readings', () => {
  const before = structuredClone(fixtures);
  for (const random of [() => 0, () => 0.5, () => 1]) {
    const result = jitterMachines(fixtures, random);
    for (const [index, machine] of result.entries()) {
      const original = fixtures[index];
      assert.equal(machine.status, original.status);
      assert.equal(machine.health, original.health);
      assert.deepEqual(machine.fault, original.fault);
      for (const key of Object.keys(machine.sensors) as (keyof Machine['sensors'])[]) {
        assert.ok(machine.sensors[key] >= 0);
        assert.ok(Math.abs(machine.sensors[key] - original.sensors[key]) <= (key === 'rpm' ? 4 : 0.41));
        if (original.sensors[key] === 0) assert.equal(machine.sensors[key], 0);
      }
    }
  }
  assert.deepEqual(fixtures, before);
});
test('websocket URL uses the correct security and preserves deployment prefix', () => {
  assert.equal(websocketUrl('http://localhost:8000/'), 'ws://localhost:8000/ws/telemetry');
  assert.equal(websocketUrl('https://factory.example/backend/'), 'wss://factory.example/backend/ws/telemetry');
});
