import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiChipText, applyResponse, buildRequest, canGuide, classify, engineBadge, isStale, mockCopilot, newSession } from '../src/copilot-logic.ts';
import type { Machine } from '../src/types.ts';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../shared/mock/${name}`, import.meta.url), 'utf8'));
const machines = read('machines.json') as Machine[];
const procedure = read('procedure_BRG-OVERHEAT.json');
const pump = machines.find(m => m.id === 'PUMP-03')!;
const cnc = machines.find(m => m.id === 'CNC-01')!;

test('engine badge shows Qualcomm, other LLMs and the scripted fallback', () => {
  assert.deepEqual(engineBadge('llm', 'Qualcomm Cloud AI 100 · Llama-3.3-70B'), { label: '⚡ Qualcomm Cloud AI 100', kind: 'qualcomm' });
  assert.equal(engineBadge('llm', 'Anthropic · claude-haiku-5-5')?.kind, 'llm');
  assert.deepEqual(engineBadge('scripted', 'Scripted fallback'), { label: 'Scripted fallback', kind: 'scripted' });
  assert.equal(engineBadge(null, null), null);
});

test('AI chip text follows /api/health', () => {
  assert.equal(aiChipText({ provider: 'qualcomm', engine: 'x' }), 'AI: Qualcomm Cloud AI 100');
  assert.equal(aiChipText({ provider: 'scripted', engine: 'x' }), 'AI: scripted fallback');
  assert.equal(aiChipText({ provider: 'anthropic', engine: 'Anthropic · claude' }), 'AI: Anthropic · claude');
  assert.equal(aiChipText(null), 'AI: unavailable');
});

test('only machines with a fault and a non-ok status can be guided', () => {
  assert.equal(canGuide(pump), true);
  assert.equal(canGuide(cnc), false);
});

test('message classification matches the contract', () => {
  assert.deepEqual(['start', ' Done ', 'next', 'ok!', 'what torque?'].map(classify), ['start', 'advance', 'advance', 'advance', 'question']);
});

test('full BRG-OVERHEAT walkthrough through the mock copilot and session reducer', () => {
  let session = newSession(pump);
  const say = (message: string) => {
    const response = mockCopilot(buildRequest(session, message), procedure, pump);
    session = applyResponse(session, message, response);
    return response;
  };
  let r = say('start');
  assert.equal(r.step.index, 0);
  assert.ok(r.reply.includes(procedure.steps[0].safety_warning));
  assert.equal(session.started, true);
  r = say('what is the temperature?');
  assert.equal(r.step.index, 0); // questions never advance
  assert.equal(r.done, false);
  for (let i = 1; i < procedure.steps.length; i++) {
    r = say('done');
    assert.equal(r.step.index, i);
    assert.equal(r.done, false);
    if (procedure.steps[i].safety_warning) assert.ok(r.reply.includes(procedure.steps[i].safety_warning));
  }
  r = say('done'); // last step finished
  assert.equal(r.done, true);
  assert.equal(session.done, true);
  assert.equal(r.step.index, procedure.steps.length - 1);
  assert.equal(r.source, 'scripted');
  assert.equal(session.history.length, 2 * (procedure.steps.length + 2));
});

test('requests carry the current step and bounded history', () => {
  let session = newSession(pump);
  for (let i = 0; i < 10; i++) session = applyResponse(session, 'q', mockCopilot(buildRequest(session, 'q'), procedure, pump));
  const req = buildRequest(session, 'done');
  assert.equal(req.machine_id, 'PUMP-03');
  assert.equal(req.step_index, 0);
  assert.ok(req.history.length <= 8);
  assert.deepEqual(Object.keys(req).sort(), ['history', 'machine_id', 'message', 'step_index']);
});

test('a session goes stale when the machine gets a different fault', () => {
  const session = newSession(pump);
  assert.equal(isStale(session, pump), false);
  assert.equal(isStale(session, { ...pump, fault: { ...pump.fault!, code: 'HYD-LEAK' } }), true);
  assert.equal(isStale(session, { ...pump, fault: null }), false); // repaired: keep the completion card
});
