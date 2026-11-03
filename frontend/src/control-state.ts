import type { ControlAction, ControlPolicy } from './types.ts';

export type ControlCommand = 'approve' | 'reject' | 'revert';
export function mergeControlActions(snapshot: ControlAction[], updates: ControlAction[]): ControlAction[] {
  const actions = new Map(snapshot.map(action => [action.id, action]));
  for (const action of updates) actions.set(action.id, action);
  return [...actions.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).slice(-50);
}

/** Interaction preview only; the live backend owns policy decisions and safety checks. */
export class MockControlStore {
  private actions: ControlAction[];
  private policy: ControlPolicy;
  constructor(actions: ControlAction[], policy: ControlPolicy) {
    this.actions = structuredClone(actions);
    this.policy = structuredClone(policy);
  }
  getActions() { return structuredClone(this.actions); }
  getPolicy() { return structuredClone(this.policy); }
  updatePolicy(patch: Partial<ControlPolicy>) {
    this.policy = { ...this.policy, ...patch };
    return this.getPolicy();
  }
  command(id: string, command: ControlCommand): ControlAction {
    const action = this.actions.find(item => item.id === id);
    if (!action) throw new Error('Unknown control action');
    const expected = command === 'revert' ? 'active' : 'proposed';
    if (action.status !== expected) throw new Error(`Action is no longer ${expected}. Refresh to see its current state.`);
    action.status = command === 'approve' ? 'active' : command === 'reject' ? 'rejected' : 'reverted';
    return structuredClone(action);
  }
}
