import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createMachine } from './models';
import type { Machine, Status } from './types';

const colors: Record<Status, number> = { ok: 0x55d6af, warning: 0xf0bc62, fault: 0xff6b76 };
export function relevantSensors(machine: Machine): string {
  const s = machine.sensors;
  if (machine.type === 'press') return `${s.pressure_bar.toFixed(1)} bar · ${s.temperature_c.toFixed(1)} °C`;
  if (machine.type === 'conveyor') return `${s.rpm.toFixed(0)} rpm · ${s.vibration_mm_s.toFixed(1)} mm/s`;
  return `${s.temperature_c.toFixed(1)} °C · ${s.vibration_mm_s.toFixed(1)} mm/s`;
}

export class FactoryScene {
  readonly scene = new THREE.Scene();
  readonly twin = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(43, 1, 0.1, 100);
  readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  readonly controls: OrbitControls;
  private labels = new CSS2DRenderer();
  private models = new Map<string, { group: THREE.Group; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; label: HTMLButtonElement; machine: Machine }>();
  private resize: ResizeObserver;
  private selected: string | null = null;
  private pointerStart = new THREE.Vector2();
  onXRFrame?: (frame: XRFrame | undefined) => void; // F5

  constructor(private host: HTMLElement, private onSelect: (id: string) => void) {
    this.scene.background = new THREE.Color(0x111c27);
    this.scene.fog = new THREE.Fog(0x111c27, 25, 55);
    this.scene.add(this.twin);
    this.camera.position.set(13, 14, 18);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D factory. Drag to orbit, scroll to zoom. Select a machine using its label or the asset list.');
    this.renderer.domElement.tabIndex = 0;
    host.append(this.renderer.domElement);
    this.labels.domElement.className = 'scene-labels';
    host.append(this.labels.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.4, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 30;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.scene.add(new THREE.HemisphereLight(0xd9efff, 0x354251, 2.5));
    const sun = new THREE.DirectionalLight(0xffe7cc, 3);
    sun.position.set(-4, 14, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
    sun.shadow.bias = -0.001;
    this.scene.add(sun);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.2, 10), new THREE.MeshStandardMaterial({ color: 0x253440, roughness: 0.95 }));
    floor.position.y = -0.12;
    floor.receiveShadow = true;
    this.twin.add(floor);
    const grid = new THREE.GridHelper(14, 28, 0x42606a, 0x304550);
    grid.position.y = 0.005;
    grid.scale.z = 10 / 14;
    this.twin.add(grid);
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(12.8, 0.035), new THREE.MeshBasicMaterial({ color: 0xb39a58 }));
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0.015, 0.1);
    this.twin.add(lane);
    this.resize = new ResizeObserver(() => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
      this.labels.setSize(width, height);
    });
    this.resize.observe(host);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.renderer.setAnimationLoop((time, frame) => { // F5: WebXR passes the XRFrame
      this.onXRFrame?.(frame); // F5
      this.controls.update();
      for (const item of this.models.values()) {
        item.ring.material.opacity = item.machine.status === 'fault' ? 0.55 + Math.sin(time / 350) * 0.25 : 0.65;
      }
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  private pointerDown = (event: PointerEvent) => this.pointerStart.set(event.clientX, event.clientY);
  private pointerUp = (event: PointerEvent) => {
    if (this.pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    for (const hit of ray.intersectObjects([...this.models.values()].map(model => model.group), true)) {
      const id = hit.object.userData.machineId as string | undefined;
      if (id) { this.onSelect(id); break; }
    }
  };

  update(machines: Machine[]) {
    for (const machine of machines) {
      let model = this.models.get(machine.id);
      if (!model) {
        const group = createMachine(machine);
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.42, 64), new THREE.MeshBasicMaterial({ color: colors[machine.status], transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.025;
        group.add(ring);
        const label = document.createElement('button');
        label.className = 'machine-label';
        label.addEventListener('click', () => this.onSelect(machine.id));
        const anchor = new CSS2DObject(label);
        anchor.position.set(0, machine.type === 'press' ? 3.25 : 2.85, 0);
        group.add(anchor);
        model = { group, ring, label, machine };
        this.models.set(machine.id, model);
        this.twin.add(group);
      }
      model.machine = machine;
      model.ring.material.color.setHex(colors[machine.status]);
      model.label.dataset.status = machine.status;
      // Data is rendered as text, never as API-supplied HTML.
      model.label.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = machine.name;
      const health = document.createElement('span');
      health.className = 'label-health';
      health.textContent = `${Math.round(machine.health)}% · ${machine.status.toUpperCase()}`;
      const sensors = document.createElement('small');
      sensors.textContent = relevantSensors(machine);
      model.label.append(title, health, sensors);
    }
    this.select(this.selected);
  }

  select(id: string | null) {
    this.selected = id;
    for (const [machineId, model] of this.models) {
      const selected = machineId === id;
      model.label.classList.toggle('selected', selected);
      model.label.setAttribute('aria-pressed', String(selected));
      model.ring.scale.setScalar(selected ? 1.12 : 1);
    }
  }

  resetView() {
    this.camera.position.set(13, 14, 18);
    this.controls.target.set(0, 0.4, 0);
  }

  dispose() {
    this.resize.disconnect();
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      }
    });
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
