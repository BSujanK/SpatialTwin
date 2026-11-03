import actionsFixture from '../../shared/mock/control_actions.json';
import policyFixture from '../../shared/mock/control_policy.json';
import { request, useMock } from './api';
import { MockControlStore } from './control-state';
import type { ControlCommand } from './control-state';
import type { ControlAction, ControlPolicy } from './types';

const mock = new MockControlStore(actionsFixture as ControlAction[], policyFixture as ControlPolicy);
export const getControlActions = (signal?: AbortSignal): Promise<ControlAction[]> => useMock
  ? Promise.resolve(mock.getActions()) : request('/api/control/actions?limit=50', { signal });
export const getControlPolicy = (signal?: AbortSignal): Promise<ControlPolicy> => useMock
  ? Promise.resolve(mock.getPolicy()) : request('/api/control/policy', { signal });
export const updateControlPolicy = (patch: Partial<ControlPolicy>): Promise<ControlPolicy> => useMock
  ? Promise.resolve(mock.updatePolicy(patch)) : request('/api/control/policy', { method: 'PUT', body: JSON.stringify(patch) });
export async function commandControlAction(id: string, command: ControlCommand): Promise<ControlAction> {
  if (useMock) return mock.command(id, command);
  return request(`/api/control/actions/${encodeURIComponent(id)}/${command}`, { method: 'POST' });
}
