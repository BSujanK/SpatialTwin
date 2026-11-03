import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../shared/mock/${name}.json`, import.meta.url), 'utf8'));
test('live control transport uses contract GET/PUT/POST routes and surfaces conflicts', async t => {
  const previous = process.env.VITE_USE_MOCK;
  process.env.VITE_USE_MOCK = 'false';
  t.after(() => { if (previous === undefined) delete process.env.VITE_USE_MOCK; else process.env.VITE_USE_MOCK = previous; });
  const policy = fixture('control_policy');
  const actions = fixture('control_actions');
  const calls: { path: string; options: RequestInit }[] = [];
  let conflict = false;
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    if (conflict) return new Response('{}', { status: 409, statusText: 'Conflict' });
    const result = path.includes('/actions?') ? actions : path.endsWith('/policy')
      ? { ...policy, ...JSON.parse(String(options.body ?? '{}')) }
      : { ...actions[1], status: path.endsWith('/approve') ? 'active' : path.endsWith('/reject') ? 'rejected' : 'reverted' };
    return new Response(JSON.stringify(result));
  });
  const vite = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
  t.after(() => vite.close());
  const api = await vite.ssrLoadModule('/src/control-api.ts');
  assert.deepEqual(await api.getControlActions(), actions);
  assert.deepEqual(await api.getControlPolicy(), policy);
  assert.deepEqual(await api.updateControlPolicy({ autonomy: 'auto' }), { ...policy, autonomy: 'auto' });
  assert.equal(calls[2].path, '/api/control/policy');
  assert.equal(calls[2].options.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[2].options.body)), { autonomy: 'auto' });
  for (const [command, status] of [['approve', 'active'], ['reject', 'rejected'], ['revert', 'reverted']]) {
    assert.equal((await api.commandControlAction('CA-1002', command)).status, status);
    assert.equal(calls.at(-1)?.path, `/api/control/actions/CA-1002/${command}`);
    assert.equal(calls.at(-1)?.options.method, 'POST');
  }
  conflict = true;
  await assert.rejects(api.commandControlAction('CA-1002', 'approve'), /409/);
});
