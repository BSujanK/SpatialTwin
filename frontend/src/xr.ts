import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';

// F5: WebXR AR mode. The twin root is shrunk to tabletop scale and placed on a real
// surface found with hit-test; the DOM overlay keeps the panels usable inside AR.

export interface ARSetupOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Group holding the whole factory twin; scaled and positioned by the reticle. */
  root: THREE.Group;
  /** Element that stays visible during the AR session (WebXR dom-overlay root). */
  overlay: HTMLElement;
  /** Optional orbit controls, disabled while the AR session owns the camera. */
  controls?: { enabled: boolean };
}

export interface ARHandle {
  /** Call once per render-loop frame with the XRFrame (undefined outside a session). */
  onXRFrame(frame: XRFrame | undefined): void;
}

const AR_SCALE = 0.15;
const ACCENT = 0x2dd4bf;

const styles = `
.ar-entry{position:absolute!important;bottom:56px!important;left:50%!important;right:auto!important;transform:translateX(-50%);width:auto!important;min-width:132px;padding:10px 22px!important;z-index:40!important;border:1px solid #2dd4bf!important;border-radius:999px!important;background:rgba(10,18,26,.92)!important;color:#2dd4bf!important;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:.14em;text-transform:uppercase;opacity:1!important;cursor:pointer;box-shadow:0 0 0 1px rgba(45,212,191,.15),0 8px 24px rgba(0,0,0,.45)}
.ar-entry:hover,.ar-entry:focus-visible{background:#2dd4bf!important;color:#07121a!important;outline:none}
.ar-pill{position:absolute;bottom:56px;left:50%;transform:translateX(-50%);z-index:40;padding:7px 14px;border:1px solid rgba(148,163,184,.25);border-radius:999px;background:rgba(10,18,26,.85);color:#94a3b8;font:500 11px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.04em;white-space:nowrap}
body.xr-active,body.xr-active #app,body.xr-active .workspace,body.xr-active .twin-panel{background:transparent!important}
body.xr-active .app-header,body.xr-active .app-footer,body.xr-active .scene-toolbar,body.xr-active .scene-footer,body.xr-active .scene-labels,body.xr-active #empty-state,body.xr-active .demo-controls{display:none!important}
body.xr-active #scene canvas{visibility:hidden}
body.xr-active .sidebar{position:fixed!important;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;background:rgba(10,18,26,.82)!important;backdrop-filter:blur(6px)}
body.xr-active .ar-entry{position:fixed!important;bottom:auto!important;top:14px!important;right:14px!important;left:auto!important;transform:none}
`;

function showUnsupported(overlay: HTMLElement) {
  const pill = document.createElement('div');
  pill.className = 'ar-pill';
  pill.setAttribute('role', 'status');
  pill.textContent = 'AR not supported on this device · showing 3D view';
  (document.querySelector('.twin-panel') ?? overlay).append(pill);
}

function createReticle(): THREE.Mesh {
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.09, 0.12, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ACCENT, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  reticle.renderOrder = 10;
  return reticle;
}

/** The flat slab the twin stands on; it would hide the real surface, so it is hidden in AR. */
function findFloors(root: THREE.Object3D): THREE.Object3D[] {
  const floors: THREE.Object3D[] = [];
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BoxGeometry)) return;
    const { width, height } = object.geometry.parameters;
    if (width >= 10 && height <= 0.3) floors.push(object);
  });
  return floors;
}

interface SavedState {
  background: THREE.Scene['background'];
  fog: THREE.Scene['fog'];
  scale: THREE.Vector3;
  position: THREE.Vector3;
  visible: boolean;
  floors: THREE.Object3D[];
}

export function setupAR(opts: ARSetupOptions): ARHandle {
  const { renderer, scene, root, overlay, controls } = opts;
  renderer.xr.enabled = true;
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);

  const reticle = createReticle();
  scene.add(reticle);
  let hitTestSource: XRHitTestSource | null = null;
  let saved: SavedState | null = null;

  // Taps on panels and buttons must not also place the twin.
  overlay.addEventListener('beforexrselect', event => {
    if ((event.target as Element | null)?.closest('button, select, a, .sidebar, .demo-controls')) event.preventDefault();
  });

  // The reticle stays live after placement, so a later tap re-places the twin.
  const onSelect = () => {
    if (!reticle.visible) return;
    root.position.setFromMatrixPosition(reticle.matrix);
    root.visible = true;
  };

  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    if (!session) return;
    const floors = findFloors(root);
    saved = { background: scene.background, fog: scene.fog, scale: root.scale.clone(), position: root.position.clone(), visible: root.visible, floors };
    scene.background = null;
    scene.fog = null;
    floors.forEach(floor => { floor.visible = false; });
    root.scale.setScalar(AR_SCALE);
    root.visible = false;
    if (controls) controls.enabled = false;
    document.body.classList.add('xr-active');
    session.addEventListener('select', onSelect);
    session.requestReferenceSpace('viewer')
      .then(space => session.requestHitTestSource?.({ space }))
      .then(source => { if (source) hitTestSource = source; })
      .catch(error => console.error('AR hit-test unavailable', error));
  });

  renderer.xr.addEventListener('sessionend', () => {
    hitTestSource?.cancel();
    hitTestSource = null;
    reticle.visible = false;
    document.body.classList.remove('xr-active');
    if (controls) controls.enabled = true;
    if (saved) {
      scene.background = saved.background;
      scene.fog = saved.fog;
      root.scale.copy(saved.scale);
      root.position.copy(saved.position);
      root.visible = saved.visible;
      saved.floors.forEach(floor => { floor.visible = true; });
      saved = null;
    }
    // ARButton hides the dom-overlay root when the session ends; bring the 3D page back.
    setTimeout(() => { overlay.style.display = ''; }, 0);
  });

  if (!navigator.xr) {
    showUnsupported(overlay);
  } else {
    navigator.xr.isSessionSupported('immersive-ar').catch(() => false).then(supported => {
      if (!supported) return showUnsupported(overlay);
      const button = ARButton.createButton(renderer, {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: overlay },
      });
      button.classList.add('ar-entry');
      (document.querySelector('.twin-panel') ?? overlay).append(button);
    });
  }

  return {
    onXRFrame(frame) {
      if (!frame || !hitTestSource) return;
      const space = renderer.xr.getReferenceSpace();
      const pose = space && frame.getHitTestResults(hitTestSource)[0]?.getPose(space);
      reticle.visible = !!pose;
      if (pose) reticle.matrix.fromArray(pose.transform.matrix);
    },
  };
}
