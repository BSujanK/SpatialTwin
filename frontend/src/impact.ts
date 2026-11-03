import type { AgentEvent, Kpis } from './types';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const icons: Record<AgentEvent['kind'], string> = { detect: '🔍', diagnose: '🧠', schedule: '⚛️', dispatch: '🚚', guide: '🛠️', resolve: '✅' };

export class ImpactView {
  private rows = new Map<number, HTMLLIElement>();
  private receivedHistory = false;
  private frames = new Map<HTMLElement, number>();
  private values = new Map<HTMLElement, number>();
  private targets = new Map<HTMLElement, number>();
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private hud: HTMLElement, private feed: HTMLElement, private onSelect: (id: string) => void) {
    hud.innerHTML = `
      <div class="kpi risk-kpi"><span class="eyebrow">$ AT RISK / HOUR</span><strong id="risk-value">—</strong><small>Illustrative production exposure</small></div>
      <div class="kpi"><span class="eyebrow">DOWNTIME COST AVOIDED</span><strong id="avoided-value">—</strong><small>From optimized repair orders</small></div>
      <div class="kpi"><span class="eyebrow">AVG MTTR</span><strong id="mttr-value">—</strong><small id="repairs-value">Awaiting telemetry</small></div>
      <div class="kpi"><span class="eyebrow">ACTIVE FAULTS</span><strong id="faults-value">—</strong><small>Machines requiring attention</small></div>
      <div class="technicians"><span class="eyebrow">TECHNICIANS</span><div id="technician-chips"></div></div>
    `;
    feed.innerHTML = `
      <div class="feed-heading"><div><span class="eyebrow">THE AUTONOMOUS LOOP</span><h2>Agent activity <span id="event-count">0</span></h2></div><span id="feed-state" class="feed-state">Waiting for history</span></div>
      <p id="impact-error" class="impact-error" role="status" hidden></p>
      <p id="feed-empty" class="feed-empty">No activity yet. New agent decisions appear here.</p>
      <ol id="event-list" aria-label="Agent decisions, newest first" aria-live="polite" aria-relevant="additions"></ol>
    `;
  }

  private get(id: string): HTMLElement { return this.hud.querySelector<HTMLElement>(`#${id}`) ?? this.feed.querySelector<HTMLElement>(`#${id}`)!; }

  private animateAmount(element: HTMLElement, target: number) {
    if (this.targets.get(element) === target) return;
    this.targets.set(element, target);
    cancelAnimationFrame(this.frames.get(element) ?? 0);
    const from = this.values.get(element) ?? target;
    const start = performance.now();
    const update = (time: number) => {
      const progress = this.reducedMotion ? 1 : Math.min(1, (time - start) / 160);
      const value = from + (target - from) * (1 - (1 - progress) ** 3);
      element.textContent = usd.format(value);
      this.values.set(element, value);
      if (progress < 1) this.frames.set(element, requestAnimationFrame(update));
    };
    update(start);
  }

  updateKpis(kpis: Kpis) {
    const risk = this.get('risk-value');
    risk.classList.toggle('at-risk', kpis.at_risk_usd_per_hour > 0);
    this.animateAmount(risk, kpis.at_risk_usd_per_hour);
    this.animateAmount(this.get('avoided-value'), kpis.downtime_cost_avoided_usd);
    this.get('mttr-value').textContent = kpis.avg_mttr_min === null ? '—' : `${kpis.avg_mttr_min.toFixed(1)} min`;
    this.get('repairs-value').textContent = `${kpis.repairs_completed} repairs completed`;
    this.get('faults-value').textContent = String(kpis.active_faults);
    this.get('technician-chips').replaceChildren(...kpis.technicians.map(technician => {
      const chip = document.createElement('button');
      chip.className = 'technician-chip';
      chip.dataset.state = technician.status;
      chip.disabled = !technician.machine_id;
      const name = document.createElement('strong');
      name.textContent = technician.name;
      const assignment = document.createElement('span');
      assignment.textContent = `${technician.status.replaceAll('_', ' ')}${technician.machine_id ? ` → ${technician.machine_id}` : ''}`;
      chip.append(name, assignment);
      if (technician.machine_id) chip.addEventListener('click', () => this.onSelect(technician.machine_id!));
      return chip;
    }));
  }

  updateEvents(events: AgentEvent[]) {
    const list = this.get('event-list');
    const ids = new Set(events.map(event => event.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { row.remove(); this.rows.delete(id); }
    [...events].reverse().forEach((event, index) => {
      let row = this.rows.get(event.id);
      const identity = `${event.ts}:${event.message}`;
      if (!row || row.dataset.identity !== identity) {
        row?.remove();
        row = document.createElement('li');
        row.dataset.identity = identity;
        if (this.receivedHistory) row.classList.add('event-enter');
        const entry = document.createElement(event.machine_id ? 'button' : 'div');
        entry.className = 'event-entry';
        entry.dataset.kind = event.kind;
        entry.classList.toggle('qualcomm-event', event.message.startsWith('Qualcomm Cloud AI 100:'));
        const icon = document.createElement('span');
        icon.className = 'event-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = icons[event.kind] ?? '•';
        const text = document.createElement('span');
        text.className = 'event-text';
        const heading = document.createElement('span');
        heading.className = 'event-meta';
        const kind = document.createElement('strong');
        kind.textContent = event.kind;
        const time = document.createElement('time');
        time.dateTime = event.ts;
        time.textContent = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        heading.append(kind, time);
        const message = document.createElement('span');
        message.className = 'event-message';
        message.textContent = event.message;
        text.append(heading, message);
        entry.append(icon, text);
        if (event.machine_id) entry.addEventListener('click', () => this.onSelect(event.machine_id!));
        row.append(entry);
        this.rows.set(event.id, row);
      }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    });
    this.get('event-count').textContent = String(events.length);
    this.get('feed-empty').hidden = events.length > 0;
    this.receivedHistory = true;
  }

  connection(state: string) {
    this.hud.classList.toggle('stale', state === 'reconnecting');
    this.get('feed-state').textContent = state === 'mock' ? 'MOCK HISTORY' : state === 'live' ? 'LIVE DECISIONS' : state === 'reconnecting' ? 'DISCONNECTED · LAST KNOWN VALUES' : 'CONNECTING';
  }

  error(message: string | null) {
    this.get('impact-error').textContent = message;
    this.get('impact-error').hidden = !message;
  }

  dispose() { for (const frame of this.frames.values()) cancelAnimationFrame(frame); }
}
