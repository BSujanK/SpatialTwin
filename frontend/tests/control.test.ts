import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockControlStore, mergeControlActions } from '../src/control-state.ts';
import type { ControlAction, ControlPolicy } from '../src/types.ts';

const actions = JSON.parse(readFileSync(new URL('../../shared/mock/control_actions.json', import.meta.url), 'utf8')) as ControlAction[];
const policy = JSON.parse(readFileSync(new URL('../../shared/mock/control_policy.json', import.meta.url), 'utf8')) as ControlPolicy;

test('mock commands round-trip statuses and keep fixture/returned values isolated', () => {
  const store = new MockControlStore(actions, policy);
  const proposed = actions.find(action => action.status === 'proposed')!;
  const active = actions.find(action => action.status === 'active')!;
  assert.equal(store.command(proposed.id, 'approve').status, 'active');
  assert.throws(() => store.command(proposed.id, 'approve'), /no longer proposed/);
  assert.equal(store.command(proposed.id, 'revert').status, 'reverted');
  assert.equal(store.command(active.id, 'revert').status, 'reverted');
  assert.throws(() => store.command(active.id, 'revert'), /no longer active/);
  assert.throws(() => store.command('missing', 'approve'), /Unknown/);
  assert.equal(proposed.status, 'proposed');
  const rejectedStore = new MockControlStore(actions, policy);
  assert.equal(rejectedStore.command(proposed.id, 'reject').status, 'rejected');
  const copy = rejectedStore.getActions();
  copy[0].label = 'changed';
  assert.notEqual(rejectedStore.getActions()[0].label, 'changed');
});

test('policy patches preserve the safety envelope and snapshot merging preserves newer action updates', () => {
  const store = new MockControlStore(actions, policy);
  const next = store.updatePolicy({ autonomy: 'auto' });
  assert.deepEqual(next, { ...policy, autonomy: 'auto' });
  next.max_derate_pct = 99;
  assert.equal(store.getPolicy().max_derate_pct, policy.max_derate_pct);
  const updated = { ...actions[0], rationale: 'Updated async rationale' };
  const merged = mergeControlActions(actions, [updated, updated]);
  assert.equal(merged.length, actions.length);
  assert.equal(merged.find(action => action.id === updated.id)?.rationale, updated.rationale);
});
