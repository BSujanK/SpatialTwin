import { recomputeSchedule, useMock } from './api';
import type { Machine, Schedule } from './types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function scheduleSavings(schedule: Schedule): string {
  const percentage = schedule.baseline_cost > 0 ? schedule.savings_usd / schedule.baseline_cost * 100 : 0;
  return `Quantum-inspired optimizer saves ${usd.format(schedule.savings_usd)} (${percentage.toFixed(1)}%) vs greedy`;
}

export class SchedulePanel {
  private schedule: Schedule | null = null;
  private machines = new Map<string, string>();
  private selected: string | null = null;
  private disposed = false;
  private busy = false;

  constructor(private host: HTMLElement, private onSelect: (id: string) => void, private onRanks: (schedule: Schedule) => void) {
    host.innerHTML = `
      <div class="schedule-heading"><div><span class="eyebrow">REPAIR PRIORITIES</span><h2>Optimized queue</h2></div><button class="quiet-button schedule-recompute" type="button">Re-optimize</button></div>
      <p class="schedule-savings" aria-live="polite">Loading schedule…</p>
      <p class="schedule-error" role="status" hidden></p>
      <ol class="schedule-queue" aria-label="Ranked repair queue"></ol>
      <p class="schedule-empty" hidden>All machines healthy. No repairs queued.</p>
      <p class="schedule-meta"></p>
    `;
    this.get<HTMLButtonElement>('.schedule-recompute').addEventListener('click', this.recompute);
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T { return this.host.querySelector<T>(selector)!; }

  setSchedule(schedule: Schedule) {
    if (this.disposed) return;
    this.schedule = schedule;
    this.get('.schedule-savings').textContent = scheduleSavings(schedule);
    this.get('.schedule-empty').hidden = schedule.queue.length !== 0;
    this.get('.schedule-meta').textContent = `${useMock ? 'Mock fixture · ' : ''}QUBO simulated annealing · ${new Date(schedule.generated_at).toLocaleTimeString()}`;
    this.onRanks(schedule);
    this.renderQueue();
  }

  setMachines(machines: Machine[]) {
    const changed = machines.some(machine => this.machines.get(machine.id) !== machine.name);
    this.machines = new Map(machines.map(machine => [machine.id, machine.name]));
    if (changed) this.renderQueue();
  }

  select(id: string) {
    this.selected = id;
    for (const row of this.host.querySelectorAll<HTMLButtonElement>('.schedule-item')) row.setAttribute('aria-pressed', String(row.dataset.machineId === id));
  }

  private renderQueue() {
    const items = [...(this.schedule?.queue ?? [])].sort((a, b) => a.rank - b.rank);
    this.get('.schedule-queue').replaceChildren(...items.map(item => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'schedule-item';
      button.dataset.machineId = item.machine_id;
      button.setAttribute('aria-pressed', String(item.machine_id === this.selected));
      const rank = document.createElement('span');
      rank.className = 'schedule-rank';
      rank.textContent = String(item.rank);
      const content = document.createElement('span');
      content.className = 'schedule-content';
      const name = document.createElement('strong');
      name.textContent = this.machines.get(item.machine_id) ?? item.machine_id;
      const reason = document.createElement('span');
      reason.className = 'schedule-reason';
      reason.textContent = item.reason;
      const assignment = document.createElement('small');
      assignment.textContent = `${item.machine_id} · ${item.est_repair_min} min · ${item.technician}`;
      content.append(name, reason, assignment);
      button.append(rank, content);
      button.addEventListener('click', () => this.onSelect(item.machine_id));
      row.append(button);
      return row;
    }));
  }

  private recompute = async () => {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const button = this.get<HTMLButtonElement>('.schedule-recompute');
    button.disabled = true;
    button.textContent = 'Optimizing…';
    this.get('.schedule-error').hidden = true;
    try {
      this.setSchedule(await recomputeSchedule());
    } catch {
      if (!this.disposed) {
        this.get('.schedule-error').textContent = 'Could not re-optimize. Last known queue remains visible; try again.';
        this.get('.schedule-error').hidden = false;
      }
    } finally {
      this.busy = false;
      button.disabled = false;
      button.textContent = 'Re-optimize';
    }
  };

  dispose() {
    this.disposed = true;
    this.get<HTMLButtonElement>('.schedule-recompute').removeEventListener('click', this.recompute);
  }
}
