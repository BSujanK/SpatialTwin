import * as THREE from 'three';
import type { Machine } from './types';

const steel = 0x3a3a3f;
const dark = 0x2b2b2f;
const orange = 0xff5f1f;

export function createMachine(machine: Machine): THREE.Group {
  const group = new THREE.Group();
  group.name = machine.id;
  group.position.set(machine.position.x, machine.position.y, machine.position.z);
  const add = (name: string, geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35 }));
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.machineId = machine.id;
    group.add(mesh);
    return mesh;
  };
  const box = (name: string, w: number, h: number, d: number, color: number, x: number, y: number, z: number) => add(name, new THREE.BoxGeometry(w, h, d), color, x, y, z);
  const cylinder = (name: string, r: number, h: number, color: number, x: number, y: number, z: number) => add(name, new THREE.CylinderGeometry(r, r, h, 16), color, x, y, z);
  box('base', 2.35, 0.15, 1.8, dark, 0, 0.1, 0);

  switch (machine.type) {
    case 'cnc':
      box('enclosure-left', 0.35, 1.7, 1.4, steel, -0.9, 1, 0);
      box('enclosure-right', 0.35, 1.7, 1.4, steel, 0.9, 1, 0);
      box('enclosure-top', 2.1, 0.25, 1.4, steel, 0, 1.9, 0);
      box('back', 1.6, 1.5, 0.15, dark, 0, 1, -0.6);
      box('worktable', 1.5, 0.2, 1.2, steel, 0, 0.6, 0);
      cylinder('spindle', 0.13, 0.65, 0xe7e5e4, 0, 1.3, 0);
      box('motor', 0.55, 0.3, 0.55, dark, 0, 2.15, 0);
      cylinder('bearing', 0.21, 0.12, orange, 0, 1.55, 0);
      break;
    case 'conveyor':
      for (const x of [-0.95, 0.95]) for (const z of [-0.45, 0.45]) box('support', 0.12, 0.7, 0.12, steel, x, 0.5, z);
      box('belt', 2.6, 0.15, 0.95, 0x1f1f22, 0, 0.9, 0);
      for (let x = -1.2; x <= 1.2; x += 0.3) {
        const roller = cylinder('roller', 0.08, 1.03, steel, x, 0.86, 0);
        roller.rotation.x = Math.PI / 2;
      }
      box('parcel', 0.5, 0.4, 0.5, orange, -0.3, 1.16, 0);
      cylinder('motor', 0.22, 0.4, steel, 1, 0.65, 0.65).rotation.x = Math.PI / 2;
      cylinder('bearing', 0.12, 0.12, orange, -1.15, 0.9, 0.57).rotation.x = Math.PI / 2;
      break;
    case 'pump':
      cylinder('motor', 0.43, 0.95, steel, -0.5, 0.7, 0).rotation.z = Math.PI / 2;
      cylinder('bearing', 0.24, 0.25, orange, 0.12, 0.7, 0).rotation.z = Math.PI / 2;
      cylinder('pump-housing', 0.47, 0.4, steel, 0.55, 0.7, 0).rotation.z = Math.PI / 2;
      cylinder('outlet', 0.12, 0.65, steel, 0.55, 1.12, 0);
      cylinder('valve', 0.28, 0.09, orange, 0.55, 1.48, 0);
      cylinder('hydraulic_line', 0.12, 0.85, orange, 0.55, 0.67, 0.6).rotation.x = Math.PI / 2;
      break;
    case 'robot_arm': {
      cylinder('motor', 0.5, 0.45, dark, 0, 0.4, 0);
      const lower = box('lower-arm', 0.32, 1.1, 0.35, orange, -0.25, 1.02, 0);
      lower.rotation.z = -0.45;
      cylinder('arm_joint', 0.27, 0.42, steel, 0, 1.5, 0).rotation.x = Math.PI / 2;
      const upper = box('upper-arm', 1.15, 0.26, 0.3, orange, 0.47, 1.73, 0);
      upper.rotation.z = 0.4;
      box('tool', 0.2, 0.48, 0.2, steel, 0.97, 1.7, 0);
      cylinder('bearing', 0.2, 0.15, dark, 0.95, 1.95, 0).rotation.x = Math.PI / 2;
      break;
    }
    case 'press':
      for (const x of [-0.8, 0.8]) box('column', 0.28, 1.9, 0.7, steel, x, 1.12, 0);
      box('crosshead', 2, 0.38, 0.85, steel, 0, 2.15, 0);
      cylinder('ram', 0.2, 0.65, 0xe7e5e4, 0, 1.65, 0);
      box('platen', 1.4, 0.18, 0.8, orange, 0, 1.26, 0);
      box('bed', 1.5, 0.22, 0.9, steel, 0, 0.55, 0);
      cylinder('hydraulic_line', 0.07, 1.55, orange, 1.03, 1.3, 0.2);
      cylinder('valve', 0.14, 0.15, orange, 1.03, 1.1, 0.35).rotation.x = Math.PI / 2;
      box('motor', 0.5, 0.35, 0.5, dark, 0.55, 2.5, 0);
      break;
  }
  box('panel', 0.42, 0.5, 0.16, 0x141416, -0.9, 0.85, 0.88);
  box('display', 0.28, 0.18, 0.02, 0xff5f1f, -0.9, 0.94, 0.975);
  return group;
}
