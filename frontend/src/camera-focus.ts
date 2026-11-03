import * as THREE from 'three';

export const FOCUS_DISTANCE = 4.5;       // metres from the machine while focused
export const FOCUS_MS = 600;
export const FOCUS_MIN_DISTANCE = 2.5;   // OrbitControls minDistance while focused
export const OVERVIEW_POSITION = new THREE.Vector3(9, 9.5, 12.5);
export const OVERVIEW_TARGET = new THREE.Vector3(0, 0.4, 0);

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Camera position `distance` metres from `target`, keeping the current viewing direction
 * (so the user's angle is preserved). The direction is kept slightly above the horizon so the
 * camera never ends up inside the floor.
 */
export function focusCameraPosition(
  target: THREE.Vector3,
  cameraPosition: THREE.Vector3,
  controlsTarget: THREE.Vector3,
  distance = FOCUS_DISTANCE,
): THREE.Vector3 {
  const direction = cameraPosition.clone().sub(controlsTarget);
  if (direction.lengthSq() < 1e-6) direction.copy(OVERVIEW_POSITION).sub(OVERVIEW_TARGET);
  direction.normalize();
  if (direction.y < 0.25) { direction.y = 0.25; direction.normalize(); }
  return target.clone().addScaledVector(direction, distance);
}

/** A camera move that is advanced from the render loop. */
export interface CameraTween {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
}

/** Apply the tween at `now` (ms). Returns true once it has finished. */
export function stepTween(tween: CameraTween, now: number, camera: THREE.Vector3, target: THREE.Vector3): boolean {
  const t = tween.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - tween.start) / tween.duration));
  const e = easeInOutCubic(t);
  camera.lerpVectors(tween.fromPosition, tween.toPosition, e);
  target.lerpVectors(tween.fromTarget, tween.toTarget, e);
  return t >= 1;
}
