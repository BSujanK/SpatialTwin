import { request, useMock } from './api';

// F5: compact presenter panel that drives POST /api/demo/inject-fault and /api/demo/reset.

const MACHINES = ['CNC-01', 'CONV-02', 'PUMP-03', 'ROBOT-04', 'PRESS-05'];
const FALLBACK_CODES = ['BRG-OVERHEAT', 'BELT-SLIP', 'HYD-LEAK', 'SPINDLE-VIB', 'JOINT-STALL'];

const styles = `
.demo-controls{position:absolute;left:28px;top:112px;z-index:40;display:grid;grid-template-columns:1fr 1fr;gap:6px;width:min(300px,calc(100vw - 28px));padding:10px;border:1px solid #2A2A2E;border-radius:10px;background:rgba(11,11,12,.92);color:#F7F5F2;font:500 11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.demo-controls .demo-title{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0!important;border:0!important;background:none!important;color:#FF5F1F!important;letter-spacing:.14em;font-size:10px!important;text-align:left;cursor:pointer}
.demo-controls .demo-title .chev{display:inline-block;transition:transform .2s ease;font-size:12px}
.demo-controls.collapsed{width:auto;grid-template-columns:auto;padding:8px 12px}
.demo-controls.collapsed > :not(.demo-title){display:none}
.demo-controls.collapsed .demo-title .chev{transform:rotate(-90deg)}
.demo-controls select,.demo-controls button{min-width:0;padding:7px 8px;border:1px solid #2A2A2E;border-radius:6px;background:#1C1C1F;color:inherit;font:inherit}
.demo-controls button{cursor:pointer}
.demo-controls button.primary{border-color:#FF5F1F;background:#FF5F1F;color:#0B0B0C;font-weight:700}
.demo-controls button:disabled{opacity:.45;cursor:not-allowed}
.demo-controls .demo-status{grid-column:1/-1;min-height:1.3em;color:#B8B3AD}
.demo-controls .demo-status[data-error]{color:#FF6B6B}
`;

function option(value: string, label = value): HTMLOptionElement {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  return item;
}

export function mountDemoControls(container: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);

  const panel = document.createElement('section');
  panel.className = 'demo-controls';
  panel.setAttribute('aria-label', 'Demo controls');
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'demo-title';
  title.innerHTML = '<span>DEMO CONTROLS</span><span class="chev" aria-hidden="true">▾</span>';
  // Collapsible: starts collapsed so the twin stays clear; the choice is remembered.
  const KEY = 'spatialtwin.demoControls.collapsed';
  const setCollapsed = (collapsed: boolean) => {
    panel.classList.toggle('collapsed', collapsed);
    title.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
  };
  let initial = true;
  try { initial = localStorage.getItem(KEY) !== '0'; } catch { /* private mode */ }
  setCollapsed(initial);
  title.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  const fault = document.createElement('select');
  fault.setAttribute('aria-label', 'Fault code');
  fault.append(...FALLBACK_CODES.map(code => option(code)));
  const machine = document.createElement('select');
  machine.setAttribute('aria-label', 'Machine');
  machine.append(...MACHINES.map(id => option(id)));
  const inject = document.createElement('button');
  inject.className = 'primary';
  inject.textContent = 'Inject fault';
  const reset = document.createElement('button');
  reset.textContent = 'Reset demo';
  const status = document.createElement('span');
  status.className = 'demo-status';
  status.setAttribute('role', 'status');
  panel.append(title, fault, machine, inject, reset, status);
  container.append(panel);

  const report = (message: string, error = false) => {
    status.textContent = message;
    if (error) status.dataset.error = ''; else delete status.dataset.error;
  };

  if (useMock) {
    // The mock data layer has no fault-injection hook; the controls need the live backend.
    for (const control of [inject, reset]) {
      control.disabled = true;
      control.title = 'Demo controls need the live backend (VITE_USE_MOCK is on)';
    }
    return;
  }

  request<{ fault_code: string; title: string }[]>('/api/procedures')
    .then(procedures => {
      if (!procedures.length) return;
      fault.replaceChildren(...procedures.map(item => option(item.fault_code, `${item.fault_code} · ${item.title}`)));
    })
    .catch(() => { /* Keep the built-in fault codes when the procedure list is unavailable. */ });

  const run = async (button: HTMLButtonElement, path: string, body: unknown, success: string) => {
    button.disabled = true;
    try {
      await request(path, { method: 'POST', body: JSON.stringify(body) });
      report(success);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Request failed', true);
    } finally {
      button.disabled = false;
    }
  };
  inject.addEventListener('click', () => void run(inject, '/api/demo/inject-fault', { machine_id: machine.value, code: fault.value }, `Injected ${fault.value} on ${machine.value}`));
  reset.addEventListener('click', () => void run(reset, '/api/demo/reset', {}, 'Demo reset'));
}
