import * as THREE from 'three';
import type { Machine } from './types.ts';

const statusColors = { ok: 0x3ddc97, warning: 0xffd23f, fault: 0xff3b3b };
export function controlVisual(machine: Machine) {
  const mode = machine.control?.mode ?? 'nominal';
  const speed = Math.max(0, Math.min(100, machine.control?.setpoints.speed_pct ?? 100));
  return {
    mode,
    color: mode === 'safe_stop' ? 0x8e8a85 : mode === 'mitigated' ? 0xff5f1f : statusColors[machine.status],
    chip: mode === 'safe_stop' ? '⏸ STOPPED' : mode === 'mitigated' ? `⚙ ${Math.round(speed)}%` : null,
    speed: mode === 'safe_stop' ? 0 : speed / 100,
    pulse: mode === 'nominal' && machine.status === 'fault',
  };
}

/** Visual motion, intentionally slowed for legibility; never represents physical RPM. */
export class MachineMotion {
  private rotating: THREE.Object3D[] = [];
  private parcel: THREE.Object3D | undefined;
  private phase = 0;

  constructor(group: THREE.Group, type: Machine['type']) {
    group.traverse(object => {
      const rotates = type === 'cnc' ? object.name === 'spindle'
        : type === 'conveyor' ? object.name === 'roller'
        : type === 'pump' ? object.name === 'motor'
        : type === 'robot_arm' ? object.name === 'arm_joint' : false;
      if (rotates) this.rotating.push(object);
    });
    // A contrasting stripe makes rotation visible on otherwise symmetric primitives.
    for (const part of this.rotating) {
      if (!(part instanceof THREE.Mesh) || !(part.geometry instanceof THREE.CylinderGeometry)) continue;
      const geometry = part.geometry.parameters;
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(.035, geometry.height * .75, .035), new THREE.MeshStandardMaterial({ color: 0xff7a45, roughness: .6 }));
      stripe.position.x = geometry.radiusTop;
      stripe.name = 'motion-stripe';
      stripe.userData.machineId = group.name;
      part.add(stripe);
    }
    if (type === 'conveyor') this.parcel = group.getObjectByName('parcel');
  }

  update(machine: Machine, deltaSeconds: number, reducedMotion: boolean) {
    if (reducedMotion) return;
    const speed = controlVisual(machine).speed;
    const delta = Math.max(0, Math.min(.1, deltaSeconds)) * speed;
    if (delta === 0) return;
    this.phase += delta;
    for (const part of this.rotating) part.rotateY(delta * 5);
    if (this.parcel) this.parcel.position.x = ((this.phase * .65 + .8) % 2.2) - 1.1;
  }
}
