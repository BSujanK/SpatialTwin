import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mesh } from 'three';
import { createMachine } from '../src/models.ts';
import type { Machine } from '../src/types.ts';

const machines = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8')) as Machine[];
test('every machine exposes selectable geometry, a panel, motor, and its fault part', () => {
  for (const machine of machines) {
    const model = createMachine(machine);
    assert.deepEqual(model.position.toArray(), [machine.position.x, machine.position.y, machine.position.z]);
    for (const name of ['panel', 'motor', ...(machine.fault ? [machine.fault.part] : [])]) {
      const part = model.getObjectByName(name);
      assert.ok(part instanceof Mesh, `${machine.id}: missing ${name}`);
      assert.equal(part.userData.machineId, machine.id);
    }
  }
  const pump = createMachine(machines.find(machine => machine.type === 'pump')!);
  for (const part of ['panel', 'motor', 'bearing']) assert.ok(pump.getObjectByName(part));
});
