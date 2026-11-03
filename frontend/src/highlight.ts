import * as THREE from 'three';
import type { Part } from './types.ts';

/** Owns temporary material changes; clearing restores the exact original materials. */
export class PartHighlighter {
  readonly arrow = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private original: THREE.Material | THREE.Material[] | null = null;
  private glowing: THREE.MeshStandardMaterial[] = [];
  private bounds = new THREE.Box3();
  private point = new THREE.Vector3();
  private root: THREE.Group;

  constructor(root: THREE.Group) {
    this.root = root;
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.26, 12), material);
    tip.rotation.z = Math.PI;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 8), material);
    shaft.position.y = 0.25;
    this.arrow.add(tip, shaft);
    this.arrow.traverse(object => { object.renderOrder = 10; });
    this.arrow.visible = false;
    root.add(this.arrow);
  }

  highlightPart(machine: THREE.Group | undefined, part: Part | null): boolean {
    this.clear();
    const target = part ? machine?.getObjectByName(part) : undefined;
    if (!(target instanceof THREE.Mesh)) return false;
    this.mesh = target;
    this.original = target.material;
    const materials = Array.isArray(target.material) ? target.material : [target.material];
    this.glowing = materials.map(material => {
      const clone = material instanceof THREE.MeshStandardMaterial ? material.clone() : new THREE.MeshStandardMaterial({ color: 0xff5f1f });
      clone.emissive.setHex(0xff5f1f); // plasma orange, unmistakable against the graphite scene
      clone.emissiveIntensity = 1.6;
      return clone;
    });
    target.material = Array.isArray(target.material) ? this.glowing : this.glowing[0];
    this.arrow.visible = true;
    return true;
  }

  update(time: number, reducedMotion = false) {
    if (!this.mesh) return;
    for (const material of this.glowing) material.emissiveIntensity = reducedMotion ? 1.6 : 1.7 + Math.sin(time / 180) * 0.9;
    this.bounds.setFromObject(this.mesh);
    this.bounds.getCenter(this.point);
    this.point.y = this.bounds.max.y;
    this.root.worldToLocal(this.point);
    this.arrow.position.copy(this.point);
    this.arrow.position.y += 0.8 + (reducedMotion ? 0 : (Math.sin(time / 220) + 1) * 0.12); // arrow tip stays >= 0.6 m above the part
  }

  clear() {
    if (this.mesh && this.original) this.mesh.material = this.original;
    for (const material of this.glowing) material.dispose();
    this.glowing = [];
    this.mesh = null;
    this.original = null;
    this.arrow.visible = false;
  }

  dispose() {
    this.clear();
    this.arrow.traverse(object => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    (this.arrow.children[0] as THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>).material.dispose();
    this.arrow.removeFromParent();
  }
}
