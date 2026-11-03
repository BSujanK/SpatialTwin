import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { mergeEvents, failureCountdown } from '../src/data.ts';
import { placeLabel } from '../src/label-layout.ts';
import { createMachine } from '../src/models.ts';
import { PartHighlighter } from '../src/highlight.ts';
import type { AgentEvent, Machine } from '../src/types.ts';

const machines = JSON.parse(readFileSync(new URL('../../shared/mock/machines.json', import.meta.url), 'utf8')) as Machine[];
const events = JSON.parse(readFileSync(new URL('../../shared/mock/events.json', import.meta.url), 'utf8')) as AgentEvent[];

test('event history preserves in-flight events, deduplicates and bounds retained decisions', () => {
  const next: AgentEvent = { ...events[0], id: Math.max(...events.map(event => event.id)) + 1, message: 'New detection' };
  const expected = [...events.map(event => event.id), next.id].sort((a, b) => a - b);
  assert.deepEqual(mergeEvents(events, [next, next]).map(event => event.id), expected);
  assert.deepEqual(mergeEvents(events, [next], 3).map(event => event.id), expected.slice(-3));
  assert.equal(failureCountdown(null), null);
  assert.equal(failureCountdown(17.2), 'fails in 18 min');
  assert.equal(failureCountdown(0), 'failure imminent');
  assert.equal(failureCountdown(-1), 'failure imminent');
});

test('default camera label placement stays separated inside projector-sized scene bounds', () => {
  for (const viewport of [1280, 1440, 1920]) {
    const width = viewport - 360;
    const height = 438;
    const camera = new THREE.PerspectiveCamera(43, width / height, .1, 100);
    camera.position.set(13, 14, 18);
    camera.lookAt(0, .4, 0);
    camera.updateMatrixWorld();
    const occupied: ReturnType<typeof placeLabel>[] = [];
    for (const machine of machines) {
      const model = createMachine(machine);
      const bounds = new THREE.Box3().setFromObject(model);
      const point = new THREE.Vector3(machine.position.x, bounds.max.y + .75, machine.position.z).project(camera);
      const rect = placeLabel({ x: (point.x + 1) * width / 2 - 75, y: (1 - point.y) * height / 2 - 32, w: 150, h: 64 }, occupied, width, height);
      assert.ok(rect.x >= 0 && rect.x + rect.w <= width, `${viewport}: horizontal bounds`);
      assert.ok(rect.y >= 98 && rect.y + rect.h <= height - 45, `${viewport}: vertical bounds`);
      assert.ok(occupied.every(other => rect.x + rect.w <= other.x || other.x + other.w <= rect.x || rect.y + rect.h <= other.y || other.y + other.h <= rect.y), `${viewport}: overlapping label`);
      occupied.push(rect);
    }
  }
});

test('part highlight restores materials, follows transformed parts and clears safely', () => {
  const root = new THREE.Group();
  const pump = createMachine(machines.find(machine => machine.type === 'pump')!);
  root.add(pump);
  const bearing = pump.getObjectByName('bearing') as THREE.Mesh;
  const original = bearing.material;
  const highlighter = new PartHighlighter(root);
  assert.equal(highlighter.highlightPart(pump, 'bearing'), true);
  assert.notEqual(bearing.material, original);
  root.scale.setScalar(.15);
  root.position.set(1, 2, 3);
  highlighter.update(1000);
  assert.ok(highlighter.arrow.position.toArray().every(Number.isFinite));
  assert.equal(highlighter.arrow.visible, true);
  highlighter.highlightPart(pump, 'panel');
  assert.equal(bearing.material, original);
  assert.equal(highlighter.highlightPart(pump, 'arm_joint'), false);
  assert.equal(highlighter.arrow.visible, false);
  highlighter.dispose();
});
