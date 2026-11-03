import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FOCUS_DISTANCE, easeInOutCubic, focusCameraPosition, stepTween, type CameraTween } from '../src/camera-focus.ts';

test('easing starts at 0, ends at 1 and is monotonic', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  let previous = -1;
  for (let i = 0; i <= 20; i++) { const v = easeInOutCubic(i / 20); assert.ok(v >= previous); previous = v; }
});

test('focus puts the camera ~4.5 m from the machine and keeps the viewing angle', () => {
  const target = new THREE.Vector3(4, 0.6, -2);
  const controlsTarget = new THREE.Vector3(0, 0.4, 0);
  const camera = new THREE.Vector3(9, 9.5, 12.5);
  const next = focusCameraPosition(target, camera, controlsTarget);
  assert.ok(Math.abs(next.distanceTo(target) - FOCUS_DISTANCE) < 1e-6);
  const before = camera.clone().sub(controlsTarget).normalize();
  const after = next.clone().sub(target).normalize();
  assert.ok(before.dot(after) > 0.999);
});

test('focus never puts the camera below the horizon', () => {
  const next = focusCameraPosition(new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(10, 0.1, 0), new THREE.Vector3(0, 0.4, 0));
  assert.ok(next.y > 0.6 + 1);
});

test('tween moves camera and target, finishes exactly at the goal, and instant when duration is 0', () => {
  const tween: CameraTween = {
    fromPosition: new THREE.Vector3(9, 9.5, 12.5), toPosition: new THREE.Vector3(1, 2, 3),
    fromTarget: new THREE.Vector3(0, 0.4, 0), toTarget: new THREE.Vector3(4, 0.6, -2),
    start: 1000, duration: 600,
  };
  const camera = tween.fromPosition.clone();
  const target = tween.fromTarget.clone();
  assert.equal(stepTween(tween, 1000, camera, target), false);
  assert.ok(camera.equals(tween.fromPosition));
  assert.equal(stepTween(tween, 1300, camera, target), false);
  assert.ok(camera.distanceTo(tween.fromPosition) > 0 && camera.distanceTo(tween.toPosition) > 0);
  assert.equal(stepTween(tween, 1600, camera, target), true);
  assert.ok(camera.equals(tween.toPosition) && target.equals(tween.toTarget));
  assert.equal(stepTween({ ...tween, duration: 0 }, 1000, camera, target), true);
});
