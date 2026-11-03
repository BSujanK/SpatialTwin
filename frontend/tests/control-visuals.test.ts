import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { controlVisual, MachineMotion } from '../src/control-visuals.ts';
import { createMachine } from '../src/models.ts';
import type { Machine } from '../src/types.ts';

const fixtures = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8')) as Machine[];
test('control state overrides fault color but preserves the underlying machine status', () => {
  const pump = structuredClone(fixtures.find(machine => machine.type === 'pump')!);
  assert.equal(controlVisual(pump).color, 0xff5f1f);
  assert.equal(controlVisual(pump).chip, '⚙ 70%');
  assert.equal(controlVisual(pump).pulse, false);
  assert.equal(pump.status, 'fault');
  pump.control.mode = 'safe_stop';
  assert.equal(controlVisual(pump).color, 0x8e8a85);
  assert.equal(controlVisual(pump).chip, '⏸ STOPPED');
  assert.equal(controlVisual(pump).speed, 0);
  pump.control.mode = 'nominal';
  assert.equal(controlVisual(pump).color, 0xff3b3b);
  assert.equal(controlVisual(pump).chip, null);
  assert.equal(controlVisual(pump).pulse, true);
  const legacy = { ...pump, control: undefined } as unknown as Machine;
  assert.equal(controlVisual(legacy).speed, 1);
});

test('pump motion scales with speed and freezes under safe stop or reduced motion', () => {
  const pump = structuredClone(fixtures.find(machine => machine.type === 'pump')!);
  const fast = createMachine(pump);
  const slow = createMachine(pump);
  const fastMotion = new MachineMotion(fast, 'pump');
  const slowMotion = new MachineMotion(slow, 'pump');
  const original = fast.getObjectByName('motor')!.quaternion.clone();
  const nominal = { ...pump, control: { ...pump.control, mode: 'nominal' as const, setpoints: { ...pump.control.setpoints, speed_pct: 100 } } };
  fastMotion.update(nominal, .05, false);
  slowMotion.update(pump, .05, false);
  const fastAngle = original.angleTo(fast.getObjectByName('motor')!.quaternion);
  const slowAngle = original.angleTo(slow.getObjectByName('motor')!.quaternion);
  assert.ok(Math.abs(slowAngle / fastAngle - .7) < 1e-8);
  const still = slow.getObjectByName('motor')!.quaternion.clone();
  slowMotion.update({ ...pump, control: { ...pump.control, mode: 'safe_stop' } }, 1, false);
  assert.ok(still.equals(slow.getObjectByName('motor')!.quaternion));
  slowMotion.update(pump, .05, true);
  assert.ok(still.equals(slow.getObjectByName('motor')!.quaternion));
});

test('conveyor parcel remains fixed when stopped and resumes without a time jump', () => {
  const machine = structuredClone(fixtures.find(item => item.type === 'conveyor')!);
  const model = createMachine(machine);
  const motion = new MachineMotion(model, 'conveyor');
  motion.update(machine, .05, false);
  const position = model.getObjectByName('parcel')!.position.clone();
  machine.control.mode = 'safe_stop';
  motion.update(machine, 100, false);
  assert.ok(position.equals(model.getObjectByName('parcel')!.position));
  machine.control.mode = 'nominal';
  motion.update(machine, .05, false);
  assert.ok(Math.abs(position.x - model.getObjectByName('parcel')!.position.x) < .1);
});
