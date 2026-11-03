import { copilotAvailable, postCopilot } from './copilot-api';
import { applyResponse, buildRequest, canGuide, engineBadge, isStale, newSession, type Session } from './copilot-logic';
import type { Machine, Part } from './types';

const PART_LABELS: Record<Part, string> = {
  motor: 'Motor', belt: 'Belt', valve: 'Valve', bearing: 'Bearing', panel: 'Control panel',
  spindle: 'Spindle', arm_joint: 'Arm joint', hydraulic_line: 'Hydraulic line',
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** Guided-repair side panel. All API text is rendered with textContent, never as HTML. */
export class CopilotPanel {
  private sessions = new Map<string, Session>();
  private machine: Machine | undefined;
  private busy = false;
  private error: string | null = null;
  private speak = (() => { try { return localStorage.getItem('copilot-speak') === '1'; } catch { return false; } })();
  private highlighted: string | null = null;

  constructor(
    private root: HTMLElement,
    private highlight: (machineId: string, part: Part | null) => boolean,
  ) {
    root.setAttribute('aria-label', 'Repair copilot');
    root.setAttribute('aria-live', 'polite');
  }

  /** Called whenever the selected machine or its telemetry changes. */
  setMachine(machine: Machine | undefined) {
    const changed = this.machine?.id !== machine?.id;
    this.machine = machine;
    if (changed) {
      this.error = null;
      this.speechCancel();
    }
    const session = machine ? this.sessions.get(machine.id) : undefined;
    if (machine && session && isStale(session, machine)) this.sessions.delete(machine.id);
    // Telemetry arrives every second: re-render only when something the panel shows has changed,
    // so typed text, focus and hover are not lost.
    if (this.keyOf() !== this.lastKey) this.render();
    this.syncHighlight();
  }

  private lastKey = '';
  private keyOf() {
    const m = this.machine;
    return m ? `${m.id}|${m.status}|${m.fault?.code ?? ''}|${this.session ? 1 : 0}` : '';
  }
  private get session(): Session | undefined { return this.machine ? this.sessions.get(this.machine.id) : undefined; }

  private syncHighlight() {
    const s = this.session;
    const want = s && s.started && !s.done && s.step && this.machine ? this.machine.id : null;
    if (want) { this.highlight(want, s!.step!.part); this.highlighted = want; }
    else if (this.highlighted) { this.highlight(this.highlighted, null); this.highlighted = null; }
  }

  private async send(message: string) {
    const machine = this.machine;
    if (!machine || this.busy) return;
    const session = this.sessions.get(machine.id) ?? newSession(machine);
    this.sessions.set(machine.id, session);
    this.busy = true;
    this.error = null;
    this.render();
    try {
      const response = await postCopilot(buildRequest(session, message), machine);
      const next = applyResponse(session, message, response);
      this.sessions.set(machine.id, next);
      if (this.speak) this.say(response.reply);
    } catch (error) {
      this.error = error instanceof Error && error.name === 'TimeoutError'
        ? 'The copilot took too long to answer. Try again.'
        : 'The copilot is unreachable. Check the backend and try again.';
    } finally {
      this.busy = false;
      this.render();
      this.syncHighlight();
    }
  }

  private say(text: string) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  private speechCancel() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }

  private render() {
    this.lastKey = this.keyOf();
    const machine = this.machine;
    const session = this.session;
    if (!machine || (!canGuide(machine) && !session)) {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    this.root.hidden = false;
    const head = node('div', 'panel-heading');
    head.append(node('span', 'eyebrow', 'REPAIR COPILOT'));
    const speakLabel = node('label', 'speak-toggle');
    const speakBox = node('input');
    speakBox.type = 'checkbox';
    speakBox.checked = this.speak;
    speakBox.setAttribute('aria-label', 'Speak replies');
    speakBox.addEventListener('change', () => {
      this.speak = speakBox.checked;
      try { localStorage.setItem('copilot-speak', this.speak ? '1' : '0'); } catch { /* storage unavailable */ }
      if (!this.speak) this.speechCancel();
    });
    speakLabel.append(speakBox, document.createTextNode(' 🔊 Speak'));
    head.append(speakLabel);

    const body: HTMLElement[] = [head];
    const badge = engineBadge(session?.source ?? null, session?.engine ?? null);
    if (badge) {
      const chip = node('span', `engine-badge engine-${badge.kind}`, badge.label);
      chip.title = session?.engine ?? '';
      body.push(chip);
    }

    if (machine.fault && !(session?.done)) {
      const fault = node('div', 'copilot-fault');
      fault.append(node('strong', '', machine.fault.code), node('span', '', ` · ${machine.fault.description}`));
      fault.dataset.status = machine.status;
      body.push(fault);
    }

    if (session?.done) {
      body.push(node('div', 'copilot-done', '✅ Repair complete. The machine is back online.'));
    } else if (!session?.started) {
      const available = copilotAvailable(machine.fault?.code ?? '');
      const start = node('button', 'copilot-start', 'Start guided repair');
      start.disabled = this.busy || !available;
      start.addEventListener('click', () => void this.send('start'));
      body.push(start);
      if (!available) body.push(node('p', 'muted', 'Mock mode has a guided procedure for BRG-OVERHEAT (Coolant Pump) only.'));
    } else if (session.step) {
      const step = session.step;
      const card = node('div', 'step-card');
      card.append(node('span', 'eyebrow', `STEP ${step.index + 1} OF ${session.totalSteps}`), node('h3', '', step.title),
        node('p', '', step.instruction), node('span', 'part-chip', `◎ ${PART_LABELS[step.part] ?? step.part}`));
      if (step.safety_warning) card.append(node('div', 'safety-warning', `⚠ ${step.safety_warning}`));
      body.push(card);
      const next = node('button', 'copilot-next', 'Done → next');
      next.disabled = this.busy;
      next.addEventListener('click', () => void this.send('done'));
      body.push(next);
    }

    if (session && session.history.length) {
      const chat = node('ol', 'chat-log');
      chat.setAttribute('aria-label', 'Copilot conversation');
      for (const message of session.history) chat.append(node('li', `chat-${message.role}`, message.content));
      body.push(chat);
    }

    if (session?.started && !session.done) {
      const form = node('form', 'ask-form');
      const input = node('input', 'ask-input');
      input.type = 'text';
      input.placeholder = 'Ask a question, e.g. "what torque?"';
      input.maxLength = 200;
      input.setAttribute('aria-label', 'Ask the copilot a question');
      input.disabled = this.busy;
      const ask = node('button', 'ask-button', 'Ask');
      ask.type = 'submit';
      ask.disabled = this.busy;
      form.append(input, ask);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const text = input.value.trim();
        if (text) void this.send(text);
      });
      body.push(form);
    }

    if (this.busy) body.push(node('p', 'copilot-busy', 'Copilot is thinking…'));
    if (this.error) body.push(node('p', 'copilot-error', this.error));
    this.root.replaceChildren(...body);
  }
}
