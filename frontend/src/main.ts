import './style.css';
import { subscribeTelemetry, useMock } from './api';
import { FactoryScene, highlightPart } from './scene';
import { CopilotPanel } from './copilot'; // F3
import { getHealth } from './copilot-api'; // F3
import { aiChipText } from './copilot-logic'; // F3
import { ImpactView } from './impact';
import type { Machine } from './types';
import { setupAR } from './xr'; // F5
import { mountDemoControls } from './demo-controls'; // F5

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="app-header">
    <a class="brand" href="./"><span class="brand-mark">S</span> SpatialTwin<span class="brand-divider"></span><span class="brand-caption">OPERATIONS</span></a>
    <div class="header-right"><span class="plant">PLANT 01 / ASSEMBLY</span><span id="connection" class="connection" role="status">Connecting…</span></div>
  </header>
  <section id="impact-hud" class="impact-hud" aria-label="Maintenance business impact"></section>
  <main class="workspace">
    <section class="twin-panel" aria-label="Factory digital twin">
      <div class="scene-toolbar"><div><span class="eyebrow">THE FACTORY, IN FOCUS</span><h1>Live digital twin<span class="live-dot"></span></h1></div><button id="reset-view" class="quiet-button">Reset view ↗</button></div>
      <div id="scene"></div>
      <div id="empty-state" class="empty-state" role="status">Connecting to the factory…<small>Waiting for machine telemetry.</small></div>
      <div class="scene-footer"><div class="legend"><span><i data-status="ok"></i>Healthy</span><span><i data-status="warning"></i>Warning</span><span><i data-status="fault"></i>Fault</span></div><span>DRAG TO ORBIT · SCROLL TO ZOOM</span></div>
    </section>
    <section id="agent-feed" class="agent-feed" aria-label="Agent activity"></section>
    <aside class="sidebar" aria-label="Machine telemetry">
      <div class="panel-heading"><span class="eyebrow">PRODUCTION LINE</span><span id="asset-count" class="count">0 ASSETS</span></div>
      <div id="machine-list" class="machine-list"></div>
      <section class="details" aria-label="Selected machine">
        <div class="panel-heading"><span class="eyebrow">ASSET TELEMETRY</span><span id="selected-status" class="status-chip">—</span></div>
        <h2 id="selected-name">Select a machine</h2><p id="selected-id" class="muted">Click a model or an asset to inspect it.</p>
        <div class="health-heading"><span>Machine health</span><strong id="health-value">—</strong></div><div class="health-track"><div id="health-bar"></div></div>
        <div id="sensor-grid" class="sensor-grid"></div>
        <div id="fault-card" class="fault-card" hidden><span class="eyebrow" id="fault-code"></span><p id="fault-description"></p></div>
      </section>
      <section id="copilot-panel" class="copilot-panel" hidden></section>
      <div class="sidebar-footer"><span id="data-description"></span><span id="last-update">Awaiting data</span></div>
    </aside>
  </main>
  <footer class="app-footer"><span><i class="tiny-square"></i> SPATIAL INTELLIGENCE FOR THE FACTORY FLOOR</span><span>Illustrative plant · Simulated sensors</span></footer>
`;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let machines: Machine[] = [];
let selectedId: string | null = null;
let factory: FactoryScene | undefined;
const rows = new Map<string, HTMLButtonElement>();
const impact = new ImpactView(el('impact-hud'), el('agent-feed'), selectMachine);
const copilot = new CopilotPanel(el('copilot-panel'), highlightPart); // F3

// F3: "AI: <provider>" chip in the HUD, from GET /api/health.
const aiChip = document.createElement('span');
aiChip.className = 'ai-chip';
aiChip.textContent = 'AI: …';
el('impact-hud').append(aiChip);
const refreshAi = async () => {
  const health = await getHealth();
  aiChip.textContent = aiChipText(health?.ai ?? null);
  aiChip.dataset.provider = health?.ai.provider ?? 'unavailable';
  aiChip.title = health?.ai.engine ?? '';
};
void refreshAi();
const aiTimer = window.setInterval(refreshAi, 20000);

function selectMachine(id: string) {
  selectedId = id;
  factory?.select(id);
  renderDetails();
}

try {
  factory = new FactoryScene(el('scene'), selectMachine);
} catch (error) {
  el('empty-state').textContent = '3D rendering is unavailable. Use the asset list to inspect telemetry.';
  console.error('Could not initialize 3D view', error);
}
if (factory) { // F5
  const ar = setupAR({ renderer: factory.renderer, scene: factory.scene, camera: factory.camera, root: factory.twin, overlay: el('app'), controls: factory.controls }); // F5
  factory.onXRFrame = ar.onXRFrame; // F5
} // F5
mountDemoControls(document.querySelector<HTMLElement>('.twin-panel') ?? el('app')); // F5 (inside the twin panel)

function renderDetails() {
  for (const [id, row] of rows) row.setAttribute('aria-pressed', String(id === selectedId));
  const machine = machines.find(item => item.id === selectedId);
  if (!machine) return;
  el('selected-name').textContent = machine.name;
  el('selected-id').textContent = `${machine.id} / Criticality ${machine.criticality} of 5`;
  el('selected-status').textContent = machine.status;
  el('selected-status').dataset.status = machine.status;
  el('health-value').textContent = `${Math.round(machine.health)}%`;
  el('health-bar').style.width = `${Math.max(0, Math.min(100, machine.health))}%`;
  el('health-bar').dataset.status = machine.status;
  const sensors = [
    ['TEMPERATURE', machine.sensors.temperature_c.toFixed(1), '°C'],
    ['VIBRATION', machine.sensors.vibration_mm_s.toFixed(1), 'mm/s'],
    ['PRESSURE', machine.sensors.pressure_bar.toFixed(1), 'bar'],
    ['ROTATION', machine.sensors.rpm.toFixed(0), 'rpm'],
  ];
  el('sensor-grid').replaceChildren(...sensors.map(([label, value, unit]) => {
    const cell = document.createElement('div');
    const caption = document.createElement('span');
    caption.textContent = label;
    const reading = document.createElement('strong');
    reading.textContent = value;
    const suffix = document.createElement('small');
    suffix.textContent = unit;
    reading.append(' ', suffix);
    cell.append(caption, reading);
    return cell;
  }));
  el('fault-card').hidden = !machine.fault;
  el('fault-card').dataset.status = machine.status;
  el('fault-code').textContent = machine.fault?.code ?? '';
  el('fault-description').textContent = machine.fault?.description ?? '';
  copilot.setMachine(machine); // F3
}

el('reset-view').addEventListener('click', () => factory?.resetView());
el('data-description').textContent = useMock ? 'MOCK / 1 SECOND TICK' : 'LIVE API / WEBSOCKET';
const unsubscribe = subscribeTelemetry({
  connection(state) {
    impact.connection(state);
    const labels = { connecting: 'Connecting…', live: 'Telemetry connected', reconnecting: 'Disconnected · retrying', mock: 'Mock demo' };
    el('connection').textContent = labels[state];
    el('connection').dataset.state = state;
    if (state === 'reconnecting' && machines.length === 0 && factory) {
      el('empty-state').textContent = 'Backend unavailable. Retrying automatically… Start the backend or enable VITE_USE_MOCK=true.';
    }
  },
  kpis: kpis => impact.updateKpis(kpis),
  events: events => impact.updateEvents(events),
  schedule: schedule => factory?.setRankBadges(schedule.queue),
  impactError: message => impact.error(message),
  machines(next, ts) {
    machines = next;
    if (factory) el('empty-state').hidden = machines.length > 0;
    el('asset-count').textContent = `${machines.length} ASSETS`;
    el('last-update').textContent = `Updated ${new Date(ts).toLocaleTimeString()}`;
    for (const machine of machines) {
      let row = rows.get(machine.id);
      if (!row) {
        row = document.createElement('button');
        row.className = 'machine-row';
        row.addEventListener('click', () => selectMachine(machine.id));
        rows.set(machine.id, row);
        el('machine-list').append(row);
      }
      row.dataset.status = machine.status;
      const dot = document.createElement('i');
      dot.dataset.status = machine.status;
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = machine.name;
      const id = document.createElement('small');
      id.textContent = `${machine.id} · ${machine.status}`;
      text.append(name, id);
      const health = document.createElement('b');
      health.textContent = `${Math.round(machine.health)}%`;
      row.replaceChildren(dot, text, health);
    }
    factory?.update(machines);
    if (!selectedId && machines.length) selectMachine(machines.find(machine => machine.status === 'fault')?.id ?? machines[0].id);
    renderDetails();
  },
});

const dispose = () => { window.clearInterval(aiTimer); unsubscribe(); impact.dispose(); factory?.dispose(); window.removeEventListener('pagehide', dispose); };
if (import.meta.hot) import.meta.hot.dispose(dispose);
window.addEventListener('pagehide', dispose, { once: true });
