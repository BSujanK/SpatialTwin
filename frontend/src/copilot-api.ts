import procedureFixture from '../../shared/mock/procedure_BRG-OVERHEAT.json';
import { request, useMock } from './api';
import { mockCopilot, type Procedure } from './copilot-logic';
import type { ApiHealth, CopilotRequest, CopilotResponse, Machine } from './types';

/** Procedure used in mock mode (only BRG-OVERHEAT has a fixture). */
export const MOCK_PROCEDURE = procedureFixture as Procedure;

/** Whether a guided repair can run for this fault in the current mode. */
export const copilotAvailable = (faultCode: string): boolean => !useMock || faultCode === MOCK_PROCEDURE.fault_code;

export async function postCopilot(req: CopilotRequest, machine: Machine): Promise<CopilotResponse> {
  if (useMock) {
    await new Promise(resolve => setTimeout(resolve, 250)); // feel like a network call
    return mockCopilot(req, MOCK_PROCEDURE, machine);
  }
  // The backend allows up to ~8 s for the LLM before falling back, so wait longer than the default.
  return request<CopilotResponse>('/api/copilot', {
    method: 'POST',
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(20000),
  });
}

export async function getHealth(): Promise<ApiHealth | null> {
  if (useMock) return { ok: true, ai: { provider: 'scripted', model: null, engine: 'Scripted fallback (mock)' } };
  try { return await request<ApiHealth>('/api/health', { signal: AbortSignal.timeout(4000) }); } catch { return null; }
}
