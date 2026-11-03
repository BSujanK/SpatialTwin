import { commandControlAction, getControlActions, getControlPolicy, updateControlPolicy } from './control-api';
import { mergeControlActions } from './control-state';
import type { ControlCommand } from './control-state';
import { useMock } from './api';
import type { ConnectionState } from './api';
import type { Autonomy, ControlAction, ControlPolicy, Kpis, Machine } from './types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const descriptions: Record<Autonomy, string> = {
  advise: 'Recommendations only. Machines keep their current setpoints until an operator approves an action.',
  approve: 'New actions wait for operator approval before changing machine operation.',
  auto: 'The agent executes actions automatically inside the safety envelope. Active actions can be reverted.',
};
const text = (tag: string, value: string, className = '') => {
  const node = document.createElement(tag);
  node.textContent = value;
  node.className = className;
  return node;
};

export class ControlPanel {
  private actions: ControlAction[] = [];
  private policy: ControlPolicy | null = null;
  private names = new Map<string, string>();
  private repairing = new Set<string>();
  private state: ConnectionState = 'connecting';
  private busy = false;
  private disposed = false;
  private generation = 0;
  private load: AbortController | null = null;
  private buffered: ControlAction[] | null = null;
  private versions = new Map<string, number>();

  constructor(private host: HTMLElement, private onSelect: (id: string) => void) {
    host.innerHTML = `
      <div class="control-heading"><h2>Autonomous control</h2><button type="button" class="quiet-button control-refresh">Refresh</button></div>
      <p class="control-source">${useMock ? 'Mock controls · in-memory preview' : 'Live control policy'}</p>
      <fieldset class="autonomy-levels"><legend>Autonomy level</legend><button type="button" data-level="advise" aria-pressed="false">Advise</button><button type="button" data-level="approve" aria-pressed="false">Approve</button><button type="button" data-level="auto" aria-pressed="false">Auto</button></fieldset>
      <p class="autonomy-description">Connecting to control policy…</p><p class="control-envelope"></p>
      <p class="control-notice" role="status"></p><p class="control-error" role="alert" hidden></p>
      <div class="control-actions" aria-label="Control actions"></div>
    `;
    host.addEventListener('click', this.click);
    this.render();
  }
  private get(selector: string) { return this.host.querySelector<HTMLElement>(selector)!; }
  private writable() { return this.state === 'live' || this.state === 'mock'; }
  private error(message: string | null) {
    this.get('.control-error').textContent = message;
    this.get('.control-error').hidden = !message;
  }

  connection(state: ConnectionState) {
    const changed = state !== this.state;
    this.state = state;
    if (changed && this.writable()) void this.refresh();
    if (changed) this.render();
  }
  setMachines(machines: Machine[]) {
    if (machines.some(machine => this.names.get(machine.id) !== machine.name)) {
      this.names = new Map(machines.map(machine => [machine.id, machine.name]));
      this.render();
    }
  }
  setKpis(kpis: Kpis) {
    const repairing = new Set(kpis.technicians.filter(tech => tech.status === 'repairing' && tech.machine_id).map(tech => tech.machine_id!));
    if ([...repairing].sort().join() !== [...this.repairing].sort().join()) { this.repairing = repairing; this.render(); }
  }
  updateAction(action: ControlAction) {
    if (this.disposed) return;
    this.versions.set(action.id, (this.versions.get(action.id) ?? 0) + 1);
    this.buffered?.push(action);
    this.actions = mergeControlActions(this.actions, [action]);
    this.render();
  }

  async refresh() {
    if (this.disposed || this.busy || !this.writable()) return;
    const generation = ++this.generation;
    this.load?.abort();
    this.load = new AbortController();
    this.buffered = [];
    this.get('.control-notice').textContent = 'Refreshing controls…';
    try {
      const signal = AbortSignal.any([this.load.signal, AbortSignal.timeout(8000)]);
      const [actions, policy] = await Promise.all([getControlActions(signal), getControlPolicy(signal)]);
      if (this.disposed || generation !== this.generation) return;
      this.actions = mergeControlActions(actions, this.buffered ?? []);
      this.policy = policy;
      this.error(null);
      this.get('.control-notice').textContent = '';
    } catch {
      if (this.disposed || generation !== this.generation) return;
      this.error('Could not load controls. Last known actions remain visible. Refresh to retry.');
      this.get('.control-notice').textContent = '';
    } finally {
      if (!this.disposed && generation === this.generation) { this.buffered = null; this.render(); }
    }
  }

  private click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.matches('.control-refresh')) { void this.refresh(); return; }
    if (button.dataset.machine) { this.onSelect(button.dataset.machine); return; }
    if (button.dataset.level) { void this.mutate({ level: button.dataset.level as Autonomy }); return; }
    if (button.dataset.command && button.dataset.action) void this.mutate({ id: button.dataset.action, command: button.dataset.command as ControlCommand });
  };

  private async mutate(operation: { level: Autonomy } | { id: string; command: ControlCommand }) {
    if (this.busy || this.disposed || !this.writable()) return;
    // Cancel a history load so it cannot overwrite the acknowledged mutation.
    ++this.generation;
    this.load?.abort();
    this.buffered = null;
    this.busy = true;
    this.error(null);
    this.get('.control-notice').textContent = 'level' in operation ? 'Saving autonomy level…' : 'Applying action…';
    this.render();
    try {
      if ('level' in operation) {
        const policy = await updateControlPolicy({ autonomy: operation.level });
        if (!this.disposed) this.policy = policy;
      } else {
        const version = this.versions.get(operation.id) ?? 0;
        const action = await commandControlAction(operation.id, operation.command);
        if (!this.disposed && (this.versions.get(operation.id) ?? 0) === version) this.updateAction(action);
      }
      if (!this.disposed) this.get('.control-notice').textContent = 'Change confirmed.';
    } catch {
      if (!this.disposed) {
        this.get('.control-notice').textContent = '';
        this.error('Change was not confirmed. The action may have changed or be interlocked. Refresh before retrying.');
      }
    } finally {
      this.busy = false;
      if (!this.disposed) this.render();
    }
  }

  private render() {
    if (this.disposed) return;
    for (const button of this.host.querySelectorAll<HTMLButtonElement>('[data-level]')) {
      button.disabled = this.busy || !this.writable() || !this.policy;
      button.setAttribute('aria-pressed', String(button.dataset.level === this.policy?.autonomy));
    }
    (this.get('.control-refresh') as HTMLButtonElement).disabled = this.busy || !this.writable();
    this.get('.autonomy-description').textContent = this.policy ? descriptions[this.policy.autonomy] : 'Waiting for the control policy. Refresh if unavailable.';
    this.get('.control-envelope').textContent = this.policy ? `${this.policy.enabled ? 'Enabled' : 'Paused'} · max derate ${this.policy.max_derate_pct}% · controlled stops ${this.policy.allow_controlled_stop ? 'allowed' : 'disabled'}` : '';
    this.host.classList.toggle('control-stale', !this.writable());
    const cards = this.get('.control-actions');
    cards.replaceChildren(...[...this.actions].reverse().map(action => this.card(action)));
    if (!this.actions.length) cards.append(text('p', this.policy ? 'No control actions yet. Recommendations will appear here.' : 'No control history loaded.', 'control-empty'));
  }

  private card(action: ControlAction): HTMLElement {
    const card = document.createElement('article');
    card.className = 'control-card';
    card.dataset.status = action.status;
    const machine = text('button', this.names.get(action.machine_id) ?? action.machine_id, 'control-machine') as HTMLButtonElement;
    machine.type = 'button';
    machine.dataset.machine = action.machine_id;
    const header = document.createElement('div');
    header.className = 'control-card-heading';
    header.append(machine, text('span', action.status, 'control-status'));
    card.append(header, text('h3', action.label), text('small', `${action.id} · ${action.machine_id} · ${action.autonomy} · ${new Date(action.created_at).toLocaleTimeString()}`, 'control-meta'));
    const minutes = (value: number | null) => value === null ? 'unknown' : String(Math.max(0, Math.round(value)));
    const after = action.ttf_after_min === null && action.kinds.includes('controlled_stop') ? 'stopped' : `${minutes(action.ttf_after_min)} min`;
    const ttf = text('p', `${minutes(action.ttf_before_min)} → ${after}`, 'control-ttf');
    ttf.prepend(text('small', 'TIME TO FAILURE'));
    const bar = document.createElement('div');
    bar.className = 'control-ttf-bar';
    bar.setAttribute('aria-hidden', 'true');
    const before = document.createElement('span');
    const maximum = Math.max(action.ttf_before_min ?? 0, action.ttf_after_min ?? 0);
    before.style.width = `${maximum > 0 ? Math.min(100, (action.ttf_before_min ?? 0) / maximum * 100) : 0}%`;
    bar.hidden = action.ttf_before_min === null || action.ttf_after_min === null;
    bar.append(before);
    const tradeoff = text('p', `−${usd.format(action.throughput_cost_usd_per_hour)}/h throughput · avoids ${usd.format(action.expected_loss_avoided_usd)} expected loss`, 'control-tradeoff');
    card.append(ttf, bar, tradeoff, text('p', action.reason, 'control-reason'));
    if (action.rationale) {
      card.append(text('span', `⚡ ${action.rationale_engine ?? 'AI rationale'}`, 'engine-badge'), text('p', action.rationale, 'control-rationale'));
    }
    card.append(text('small', `Speed ${action.setpoints.speed_pct}% · load ${action.setpoints.load_pct}% · coolant ${action.setpoints.coolant_pct}%`, 'control-meta'));
    const buttons = document.createElement('div');
    buttons.className = 'control-card-buttons';
    const commands: ControlCommand[] = action.status === 'proposed' ? ['approve', 'reject'] : action.status === 'active' ? ['revert'] : [];
    for (const command of commands) {
      const button = text('button', command[0].toUpperCase() + command.slice(1), 'quiet-button') as HTMLButtonElement;
      button.type = 'button';
      button.dataset.command = command;
      button.dataset.action = action.id;
      button.disabled = this.busy || !this.writable() || (command === 'approve' && this.repairing.has(action.machine_id));
      buttons.append(button);
    }
    if (action.status === 'proposed' && this.repairing.has(action.machine_id)) buttons.append(text('small', 'Approval held: technician repairing this machine.', 'control-interlock'));
    card.append(buttons);
    return card;
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    this.load?.abort();
    this.host.removeEventListener('click', this.click);
  }
}
