import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, isHarnessPath, safeFile, redact, validCandidate, windowOf, jev } from '../src/core.mjs';
import { Store } from '../src/store.mjs';
import { DecisionTree } from '../src/tree.mjs';
import { start, request } from '../src/daemon.mjs';
import { runEvaluations, runSignals, signalQuestions } from '../src/evals.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-watch-test-'));
  await mkdir(join(root, '.pi/skills/docs'), { recursive: true });
  const file = join(root, '.pi/skills/docs/SKILL.md');
  await writeFile(file, 'Use this skill for all documentation.\n');
  await initProject(root, { consent: true, autonomous: true });
  const store = new Store(root);
  store.event({ id: 'input1', sessionId: 's1', kind: 'input', at: '2026-03-11T00:00:00Z', text: 'Update public docs' });
  store.event({ id: 'turn1', sessionId: 's1', kind: 'turn', at: '2026-03-11T00:01:00Z', response: 'Edited internal docs', tools: [] });
  store.event({ id: 'skill1', sessionId: 's1', kind: 'tool', at: '2026-03-11T00:01:30Z', name: 'read', path: '.pi/skills/docs/SKILL.md', isError: false });
  store.event({ id: 'input2', sessionId: 's1', kind: 'input', at: '2026-03-11T00:02:00Z', text: 'No, the public docs' });
  store.event({ id: 'turn2', sessionId: 's1', kind: 'turn', at: '2026-03-11T00:03:00Z', response: 'Sorry', tools: [] });
  return { root, store, file, cleanup: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}
const answer = (id, choices) => ({ type: 'choice', choice: id, probabilities: Object.fromEntries(choices.map(c => [c, c === id ? .9 : .1 / (choices.length - 1)])), confidence: .9 });
test('conditional Jev tree applies only the chosen validated edit and logs its diff', async () => {
  const f = await fixture();
  try {
    const gates = [];
    const judge = async (_state, questions) => {
      const gate = Object.keys(questions)[0]; gates.push(gate);
      if (gate === 'yes') return { answers: { yes: { type: 'noul', noul: .98 } }, model: 'test-jev' };
      const options = Object.keys(questions[gate].criteria);
      const id = gate === 'target' ? '.pi/skills/docs/SKILL.md' : gate === 'direction' ? 'narrow_trigger' : 'candidate_2';
      return { answers: { [gate]: answer(id, options) }, model: 'test-jev' };
    };
    const draft = async () => [{ effect: 'A', content: 'Use for private documentation.\n' }, { effect: 'B', content: 'Use only for internal documentation.\n' }];
    const tree = new DecisionTree(f.root, f.store, { consent: true, autonomous: true, windowTurns: 6 }, judge, draft);
    f.store.decision('warranted', 'prior', { state: { sessionId: 's1', turns: [{ id: 'turn1' }] } }, { answers: { yes: { type: 'noul', noul: .95 } } });
    await tree.run({ sessionId: 's1' });
    assert.deepEqual(gates, ['yes', 'target', 'direction', 'yes', 'candidate']);
    assert.equal(await readFile(f.file, 'utf8'), 'Use only for internal documentation.\n');
    assert.match(await readFile(join(f.root, '.agent-watch/changes.md'), 'utf8'), /```diff[\s\S]*-Use this skill/);
    assert.equal(f.store.active().status, 'watching');
    assert.equal(await tree.rollback(f.store.active(), 'test'), true);
    assert.equal(await readFile(f.file, 'utf8'), 'Use this skill for all documentation.\n');
  } finally { await f.cleanup(); }
});
test('Noul abstention stops before drafting', async () => {
  const f = await fixture(); let drafted = false;
  try {
    await new DecisionTree(f.root, f.store, { consent: true, autonomous: true }, async () => ({ answers: { yes: { type: 'noul', noul: .4 } } }), async () => { drafted = true; return []; }).run();
    assert.equal(drafted, false); assert.equal(f.store.active(), undefined);
  } finally { await f.cleanup(); }
});
test('path boundary and redaction prevent disclosure and symlink escape', async () => {
  const f = await fixture();
  try {
    assert.equal(isHarnessPath('src/app.js'), false);
    await assert.rejects(safeFile(f.root, 'src/app.js'));
    await symlink('/etc/hosts', join(f.root, '.pi/skills/docs/escape.js'));
    await assert.rejects(safeFile(f.root, '.pi/extensions/../skills/docs/escape.js'));
    assert.equal(redact({ authorization: 'Bearer abc', text: 'api_key=secretABC123456' }).authorization, '[REDACTED]');
    assert.doesNotMatch(redact('Bearer abcdefghijklmnop'), /abcdefghijklmnop/);
    assert.doesNotMatch(redact('AWS_SECRET_ACCESS_KEY=abcdefghijklmnop'), /abcdefghijklmnop/);
  } finally { await f.cleanup(); }
});
test('windows do not mix sessions or abandoned branches', () => {
  const events = [
    { id: 'a', kind: 'input', sessionId: 's1', branchId: 'root', text: 'goal' },
    { id: 'b', kind: 'turn', sessionId: 's1', branchId: 'branch-a' },
    { id: 'c', kind: 'input', sessionId: 's2', branchId: 'root', text: 'other goal' },
    { id: 'd', kind: 'turn', sessionId: 's2', branchId: 'branch-b' },
  ];
  assert.deepEqual(windowOf(events, 6, 's1', ['root', 'branch-a']).turns.map(e => e.id), ['b']);
  assert.deepEqual(windowOf(events, 6, 's1', ['root', 'branch-a']).recentInputs.map(e => e.text), ['goal']);
  assert.deepEqual(windowOf(events, 6, 's1', ['root']).turns, []);
});
test('invalid settings and extension syntax never become Jev candidates', () => {
  assert.equal(validCandidate('.pi/settings.json', '{bad'), false);
  assert.equal(validCandidate('.pi/settings.json', '{"retry":true}'), true);
  assert.equal(validCandidate('.pi/extensions/foo.js', 'const = ;'), false);
});
test('emergency pause cannot keep a change during asynchronous verification', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, 'utf8'), after = 'Use only for public documentation.\n';
    await writeFile(f.file, after);
    f.store.change({ id: 'pending', path: '.pi/skills/docs/SKILL.md', before, after, baseHash: 'base', status: 'watching', at: '2026-03-11T00:00:00Z', detail: { baseTurn: 'turn1', baseline: { turns: [] } } });
    const config = { paused: true, consent: true, autonomous: true };
    await new DecisionTree(f.root, f.store, config, async () => { throw new Error('Must not judge while paused'); }).verify(f.store.active(), { turns: [] });
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.equal(f.store.active(), undefined);
  } finally { await f.cleanup(); }
});
test('hard cost limit rolls back without asking Jev', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.file, 'utf8'), after = 'Use only for public documentation.\n';
    await writeFile(f.file, after);
    f.store.change({ id: 'cost', path: '.pi/skills/docs/SKILL.md', before, after, baseHash: 'base', status: 'watching', at: '2026-03-11T00:00:00Z', detail: { baseTurn: 'turn1', baseline: { turns: [] } } });
    const tree = new DecisionTree(f.root, f.store, { consent: true, autonomous: true, maxTurnCostUsd: .5 }, async () => { throw new Error('Jev must not override a hard limit'); });
    await tree.verify(f.store.active(), { turns: [{ id: 'later', at: '2026-03-11T00:01:00Z', costUsd: 1, tools: [] }] });
    assert.equal(await readFile(f.file, 'utf8'), before);
  } finally { await f.cleanup(); }
});
test('Jev adapter validates typed answers without contacting the network', async () => {
  let payload;
  const fetcher = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ model: 'fake', answers: { yes: { type: 'noul', noul: .8 } } }) }; };
  assert.equal((await jev({ goal: 'test' }, { yes: { type: 'noul', instructions: 'Was this good?' } }, { key: 'test-only', fetcher })).answers.yes.noul, .8);
  assert.equal(payload.state.goal, 'test');
  await assert.rejects(jev({}, { yes: { type: 'noul', instructions: '?' } }, { key: 'test-only', fetcher: async () => ({ ok: true, json: async () => ({ answers: { yes: { type: 'choice', choice: 'wrong' } } }) }) }), /Invalid Jev answer/);
});
test('built-in signal pack is batched, informational, and scoped to the settled session', async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.store.event({ id: 'alien', sessionId: 'other', kind: 'input', at: '2026-03-11T00:03:01Z', text: 'unrelated user' });
    await runSignals(f.store, { consent: true, windowTurns: 6 }, { id: 'settled', kind: 'session', reason: 'settled', sessionId: 's1' }, async (state, questions) => {
      calls++;
      assert.equal(state.recentInputs.includes('unrelated user'), false);
      assert.deepEqual(Object.keys(questions), ['correction','looping','progress','completion','tool_fit','instruction_adherence','error_recovery']);
      return { model: 'fake', answers: { correction: { type: 'noul', noul: .9 } } };
    });
    assert.equal(calls, 1);
    assert.equal(f.store.decisions()[0].gate, 'signals');
    assert.equal(signalQuestions.progress.type, 'score');
    assert.equal(f.store.active(), undefined);
  } finally { await f.cleanup(); }
});
test('custom evaluation schedule uses Jev only at the configured boundary', async () => {
  const f = await fixture(); let calls = 0, observedState;
  try {
    f.store.event({ id: 'tool-output', sessionId: 's1', kind: 'tool', at: '2026-03-11T00:03:30Z', name: 'read', isError: false, output: 'Public API returns an empty list.' });
    f.store.evaluation('custom', { description: 'Did Pi answer the request?', schedule: 'settled', every: 1, question: { type: 'noul', instructions: 'Did the assistant answer `goal`?' } });
    const judge = async state => { calls++; observedState = state; return { model: 'fake', answers: { evaluation: { type: 'noul', noul: .7 } } }; };
    await runEvaluations(f.store, { consent: true, windowTurns: 6 }, { id: 'turn2', kind: 'turn', sessionId: 's1' }, judge);
    assert.equal(calls, 0);
    await runEvaluations(f.store, { consent: true, windowTurns: 6 }, { id: 'settled', kind: 'session', reason: 'settled', sessionId: 's1' }, judge);
    assert.equal(calls, 1);
    assert.equal(observedState.tools.at(-1).output, 'Public API returns an empty list.');
    assert.equal(f.store.decisions()[0].gate, 'eval:custom');
  } finally { await f.cleanup(); }
});
test('daemon accepts local events, pause and resume without Jev access', async () => {
  const f = await fixture();
  const daemon = await start(f.root);
  try {
    await request(f.root, 'POST', '/event', { id: 'third', sessionId: 's2', kind: 'input', text: 'token=abcdef0123456789' });
    await request(f.root, 'POST', '/event', { id: 'third', sessionId: 's2', kind: 'input', text: 'token=abcdef0123456789' });
    const status = await request(f.root, 'GET', '/status');
    assert.equal(status.events.at(-1).text, '[REDACTED]');
    assert.equal(status.events.filter(e => e.id === 'third').length, 1);
    const definition = { description: 'Did it work?', schedule: 'settled', every: 1, question: { type: 'noul', instructions: 'Did the task complete?' } };
    await assert.rejects(request(f.root, 'POST', '/eval/activate', { definition: { ...definition, schedule: 'turn', every: 0 } }), /Invalid evaluation/);
    const { id } = await request(f.root, 'POST', '/eval/activate', { definition });
    await assert.rejects(request(f.root, 'POST', '/eval/update', { id, definition: { ...definition, schedule: 'turn', every: 0 } }), /Invalid evaluation/);
    await request(f.root, 'POST', '/eval/toggle', { id, enabled: false });
    assert.equal((await request(f.root, 'GET', '/status')).evaluations[0].enabled, false);
    await request(f.root, 'POST', '/eval/update', { id, definition: { ...definition, description: 'Was the answer correct?' } });
    assert.equal((await request(f.root, 'GET', '/status')).evaluations[0].description, 'Was the answer correct?');
    await request(f.root, 'POST', '/eval/remove', { id });
    assert.equal((await request(f.root, 'GET', '/status')).evaluations.length, 0);
    assert.equal((await request(f.root, 'POST', '/pause')).paused, true);
    assert.equal((await request(f.root, 'POST', '/resume')).paused, false);
  } finally { daemon.close(); await f.cleanup(); }
});
