import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createMachine } from './models';
import { controlVisual, MachineMotion } from './control-visuals';
import { failureCountdown } from './data';
import { PartHighlighter } from './highlight';
import { FOCUS_MIN_DISTANCE, FOCUS_MS, OVERVIEW_POSITION, OVERVIEW_TARGET, focusCameraPosition, stepTween, type CameraTween } from './camera-focus'; // F3b
import { placeLabel } from './label-layout';
import type { Machine, Part, ScheduleItem, Status } from './types';

let currentScene: FactoryScene | undefined;
export function highlightPart(machineId: string, part: Part | null) { return currentScene?.highlightPart(machineId, part) ?? false; }
export function setRankBadges(queue: ScheduleItem[]) { currentScene?.setRankBadges(queue); }
export function focusMachine(machineId: string | null) { currentScene?.focusMachine(machineId); } // F3b
export function flashMachine(machineId: string) { currentScene?.flashMachine(machineId); } // F3b

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
  private models = new Map<string, { group: THREE.Group; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; label: HTMLButtonElement; anchor: CSS2DObject; rank: HTMLSpanElement; machine: Machine; motion: MachineMotion }>();
  private previousFrame: number | null = null;
  private highlighter = new PartHighlighter(this.twin);
  private ranks = new Map<string, number>();
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private resize: ResizeObserver;
  private selected: string | null = null;
  private focused: string | null = null; // F3b
  private tween: CameraTween | null = null; // F3b
  private restoreMinDistance: number | null = null; // F3b
  private flashes = new Map<string, number>(); // F3b
  private pointerStart = new THREE.Vector2();
  onXRFrame?: (frame: XRFrame | undefined) => void; // F5

  constructor(private host: HTMLElement, private onSelect: (id: string) => void) {
    currentScene = this;
    this.scene.background = new THREE.Color(0x111c27);
    this.scene.fog = new THREE.Fog(0x111c27, 25, 55);
    this.scene.add(this.twin);
    this.camera.position.set(9, 9.5, 12.5);
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
      const delta = this.previousFrame === null ? 0 : (time - this.previousFrame) / 1000;
      this.previousFrame = time;
      this.onXRFrame?.(frame); // F5
      this.advanceCamera(); // F3b
      this.controls.update();
      for (const [id, item] of this.models) {
        const visual = controlVisual(item.machine);
        item.motion.update(item.machine, delta, this.reducedMotion);
        const flashing = (this.flashes.get(id) ?? 0) > performance.now(); // F3b: green flash when a repair completes
        if (flashing) {
          item.ring.material.color.setHex(colors.ok);
          item.ring.material.opacity = 0.9;
          item.ring.scale.setScalar(1.12 + (this.reducedMotion ? 0 : Math.abs(Math.sin(time / 120)) * 0.25));
          continue;
        }
        if (this.flashes.delete(id)) item.ring.scale.setScalar(id === this.selected ? 1.12 : 1);
        item.ring.material.color.setHex(visual.color);
        item.ring.material.opacity = visual.pulse && !this.reducedMotion ? 0.55 + Math.sin(time / 350) * 0.25 : 0.8;
      }
      this.highlighter.update(time, this.reducedMotion);
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
      this.arrangeLabels();
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
        const wrapper = document.createElement('div');
        wrapper.className = 'label-anchor';
        wrapper.append(label);
        const anchor = new CSS2DObject(wrapper);
        const bounds = new THREE.Box3().setFromObject(group);
        anchor.position.set(0, bounds.max.y - group.position.y + 0.75, 0);
        group.add(anchor);
        const rank = document.createElement('span');
        rank.className = 'rank-badge';
        model = { group, ring, label, anchor, rank, machine, motion: new MachineMotion(group, machine.type) };
        this.models.set(machine.id, model);
        this.twin.add(group);
      }
      model.machine = machine;
      const visual = controlVisual(machine);
      model.ring.material.color.setHex(visual.color);
      model.label.dataset.status = machine.status;
      model.label.dataset.control = visual.mode;
      // Data is rendered as text, never as API-supplied HTML.
      model.label.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = machine.name;
      const health = document.createElement('span');
      health.className = 'label-health';
      health.textContent = `${Math.round(machine.health)}%`;
      const heading = document.createElement('span');
      heading.className = 'label-heading';
      heading.append(title, health);
      const sensors = document.createElement('small');
      sensors.textContent = relevantSensors(machine);
      model.label.append(heading, sensors);
      if (visual.chip) {
        const chip = document.createElement('span');
        chip.className = 'machine-control-chip';
        chip.textContent = visual.chip;
        model.label.append(chip);
      }
      const prediction = failureCountdown(machine.predicted_failure_min);
      if (prediction) {
        const countdown = document.createElement('span');
        countdown.className = 'failure-countdown';
        countdown.textContent = prediction;
        model.label.append(countdown);
      }
      model.label.setAttribute('aria-label', `${machine.name}, ${machine.status}, ${Math.round(machine.health)}% health${visual.chip ? `, ${visual.chip}` : ''}${prediction ? `, ${prediction}` : ''}`);
      model.rank.hidden = !this.ranks.has(machine.id);
      model.rank.textContent = String(this.ranks.get(machine.id) ?? '');
      model.label.append(model.rank);
    }
    this.select(this.selected);
  }

  /** Keep compact labels inside the canvas and separate while orbiting/resizing. */
  private arrangeLabels() {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    for (const model of this.models.values()) {
      if (model.anchor.element.style.display === 'none') continue; // F3b: hidden while another machine is focused
      const point = model.anchor.getWorldPosition(new THREE.Vector3()).project(this.camera);
      if (point.z < -1 || point.z > 1) continue;
      const w = model.label.offsetWidth;
      const h = model.label.offsetHeight;
      const left = (point.x + 1) * width / 2 - w / 2;
      const top = (1 - point.y) * height / 2 - h / 2;
      const { x, y } = placeLabel({ x: left, y: top, w, h }, occupied, width, height);
      model.label.style.transform = `translate(${x - left}px, ${y - top}px)`;
      occupied.push({ x, y, w, h });
    }
  }

  highlightPart(machineId: string, part: Part | null): boolean {
    return this.highlighter.highlightPart(this.models.get(machineId)?.group, part);
  }

  setRankBadges(queue: ScheduleItem[]) {
    this.ranks = new Map(queue.map(item => [item.machine_id, item.rank]));
    for (const [id, model] of this.models) {
      model.rank.hidden = !this.ranks.has(id);
      model.rank.textContent = String(this.ranks.get(id) ?? '');
      model.rank.setAttribute('aria-label', `Repair priority ${this.ranks.get(id) ?? 'unassigned'}`);
    }
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

  resetView() { this.focusMachine(null); }

  // ---- F3b: camera focus during a repair ----
  /** Smoothly bring the camera ~4.5 m from a machine (keeping the viewing angle), or back to the overview with null. */
  focusMachine(id: string | null) {
    const model = id ? this.models.get(id) : undefined;
    this.focused = model ? id : null;
    for (const [machineId, item] of this.models) {
      item.anchor.element.style.display = this.focused && machineId !== this.focused ? 'none' : '';
      item.label.classList.toggle('compact', machineId === this.focused);
    }
    const toTarget = new THREE.Vector3();
    let toPosition: THREE.Vector3;
    if (model) {
      model.group.getWorldPosition(toTarget);
      toTarget.y += 0.6;
      toPosition = focusCameraPosition(toTarget, this.camera.position, this.controls.target);
      this.controls.minDistance = FOCUS_MIN_DISTANCE; // allow the close-up
      this.restoreMinDistance = null;
    } else {
      toTarget.copy(OVERVIEW_TARGET);
      toPosition = OVERVIEW_POSITION.clone();
      this.restoreMinDistance = 8; // restored when the move finishes, so the camera is not pushed out mid-move
    }
    this.tween = {
      fromPosition: this.camera.position.clone(), toPosition,
      fromTarget: this.controls.target.clone(), toTarget,
      start: performance.now(), duration: this.reducedMotion ? 0 : FOCUS_MS,
    };
  }

  /** Flash the machine's status ring green for ~1.5 s (repair finished). */
  flashMachine(id: string) { this.flashes.set(id, performance.now() + 1500); }

  private advanceCamera() {
    if (!this.tween || this.renderer.xr.isPresenting) { this.tween = null; return; }
    if (stepTween(this.tween, performance.now(), this.camera.position, this.controls.target)) {
      this.tween = null;
      if (this.restoreMinDistance !== null) { this.controls.minDistance = this.restoreMinDistance; this.restoreMinDistance = null; }
    }
  }

  dispose() {
    if (currentScene === this) currentScene = undefined;
    this.highlighter.dispose();
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
