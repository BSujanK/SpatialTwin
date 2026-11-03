import type { CopilotRequest, CopilotResponse, Machine, ProcedureStep } from './types.ts';

export interface Procedure { fault_code: string; title: string; steps: ProcedureStep[] }
export interface ChatMessage { role: 'user' | 'assistant'; content: string }

/** One guided repair for one machine. */
export interface Session {
  machineId: string;
  faultCode: string;
  started: boolean;
  done: boolean;
  step: ProcedureStep | null;
  totalSteps: number;
  history: ChatMessage[];
  engine: string | null;
  source: 'llm' | 'scripted' | null;
}

export const newSession = (machine: Machine): Session => ({
  machineId: machine.id, faultCode: machine.fault?.code ?? '', started: false, done: false,
  step: null, totalSteps: 0, history: [], engine: null, source: null,
});

/** The panel is offered for machines that are not ok and have a fault. */
export const canGuide = (machine: Machine): boolean => machine.status !== 'ok' && machine.fault !== null;

/** A session is stale when the machine has a different fault than the one it was started for. */
export const isStale = (session: Session, machine: Machine): boolean =>
  machine.fault !== null && machine.fault.code !== session.faultCode;

export function buildRequest(session: Session, message: string): CopilotRequest {
  return {
    machine_id: session.machineId,
    message,
    step_index: session.step?.index ?? 0,
    history: session.history.slice(-8),
  };
}

/** Apply a copilot response. The step shown is always the one the backend returned. */
export function applyResponse(session: Session, message: string, response: CopilotResponse): Session {
  return {
    ...session,
    started: true,
    done: response.done,
    step: response.step,
    totalSteps: response.total_steps,
    engine: response.engine,
    source: response.source,
    history: [...session.history, { role: 'user', content: message }, { role: 'assistant', content: response.reply }],
  };
}

export interface EngineBadge { label: string; kind: 'qualcomm' | 'llm' | 'scripted' }

export function engineBadge(source: 'llm' | 'scripted' | null, engine: string | null): EngineBadge | null {
  if (!source) return null;
  if (source === 'scripted') return { label: engine || 'Scripted fallback', kind: 'scripted' };
  if (engine?.startsWith('Qualcomm Cloud AI 100')) return { label: '⚡ Qualcomm Cloud AI 100', kind: 'qualcomm' };
  return { label: `🤖 ${engine || 'AI'}`, kind: 'llm' };
}

/** Text for the "AI:" chip in the HUD, from GET /api/health. */
export function aiChipText(ai: { provider: string; engine: string } | null): string {
  if (!ai) return 'AI: unavailable';
  if (ai.provider === 'qualcomm') return 'AI: Qualcomm Cloud AI 100';
  if (ai.provider === 'scripted') return 'AI: scripted fallback';
  return `AI: ${ai.engine}`;
}

const START = new Set(['start', 'begin', 'go']);
const ADVANCE = new Set(['done', 'next', 'ok', 'okay']);
export const classify = (message: string): 'start' | 'advance' | 'question' => {
  const m = message.trim().toLowerCase().replace(/[.!?]+$/, '');
  return START.has(m) ? 'start' : ADVANCE.has(m) ? 'advance' : 'question';
};

/** Mock-mode copilot: the same step logic as the backend contract, scripted replies only. */
export function mockCopilot(req: CopilotRequest, procedure: Procedure, machine: Machine): CopilotResponse {
  const total = procedure.steps.length;
  let idx = Math.max(0, Math.min(req.step_index, total - 1));
  const kind = classify(req.message);
  let done = false;
  let entered = false;
  if (kind === 'start') entered = true;
  else if (kind === 'advance') {
    if (idx + 1 >= total) done = true;
    else { idx += 1; entered = true; }
  }
  const step = procedure.steps[idx];
  let reply: string;
  if (done) reply = `That's the last step. ${machine.name} is repaired and back online. Nice work.`;
  else if (entered) {
    reply = `${kind === 'start' ? "Let's start." : `Good. Step ${idx + 1} of ${total}.`} ${step.instruction}`;
    if (step.safety_warning) reply += ` Safety first: ${step.safety_warning}`;
  } else {
    const s = machine.sensors;
    reply = /temp|hot|sensor|reading|vibration|pressure|rpm/i.test(req.message)
      ? `Live readings for ${machine.name}: ${s.temperature_c.toFixed(1)} °C, vibration ${s.vibration_mm_s.toFixed(1)} mm/s, pressure ${s.pressure_bar.toFixed(1)} bar, ${s.rpm} rpm.`
      : `You're on step ${idx + 1} of ${total}: ${step.title}. ${step.instruction} Say 'done' when finished.`;
  }
  return { reply, step, total_steps: total, done, source: 'scripted', engine: 'Scripted fallback (mock)' };
}
