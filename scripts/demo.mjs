#!/usr/bin/env node
// Disposable, fully offline demo. The judge and drafter below are fixtures, not Jev or Pi.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core.mjs';
import { Store } from '../src/store.mjs';
import { DecisionTree } from '../src/tree.mjs';
import { request } from '../src/daemon.mjs';

const root = await mkdtemp(join(tmpdir(), 'agent-watch-demo-'));
await mkdir(join(root, '.pi/skills/docs'), { recursive: true });
await writeFile(join(root, '.pi/skills/docs/SKILL.md'), 'Use this skill for every documentation task.\n');
await initProject(root); // No consent, no autonomous evaluation, no network.
const store = new Store(root);
const at = new Date(Date.now() - 120000).toISOString();
for (const event of [
  { id: 'demo-input-1', kind: 'input', text: 'Update the public API documentation.' },
  { id: 'demo-tool', kind: 'tool', name: 'read', path: '.pi/skills/docs/SKILL.md', isError: false },
  { id: 'demo-turn-1', kind: 'turn', response: 'I changed the internal documentation.', tools: [] },
  { id: 'demo-input-2', kind: 'input', text: 'No, I meant the public API docs.' },
  { id: 'demo-turn-2', kind: 'turn', response: 'Sorry, I will correct that.', tools: [] },
]) store.event({ ...event, sessionId: 'demo', at });
store.decision('warranted', 'demo-earlier-turn', { state: { sessionId: 'demo', turns: [{ id: 'demo-turn-1' }] } }, { model: 'fixture', answers: { yes: { type: 'noul', noul: .95 } } });
const fakeJev = async (_state, questions) => {
  const key = Object.keys(questions)[0];
  if (key === 'yes') return { model: 'fixture (not Jev)', answers: { yes: { type: 'noul', noul: .97 } } };
  const options = Object.keys(questions[key].criteria);
  const winner = key === 'target' ? '.pi/skills/docs/SKILL.md' : key === 'direction' ? 'narrow_trigger' : 'candidate_2';
  return { model: 'fixture (not Jev)', answers: { [key]: { type: 'choice', choice: winner, confidence: .9, probabilities: Object.fromEntries(options.map(option => [option, option === winner ? .9 : .1 / (options.length - 1)])) } } };
};
const fakePi = async () => [
  { effect: 'Only activate for documentation changes', content: 'Use this skill only for documentation changes.\n' },
  { effect: 'Only activate for internal documentation', content: 'Use this skill only for internal documentation tasks.\n' },
];
await new DecisionTree(root, store, { consent: true, autonomous: true, windowTurns: 6, maxDailyRequests: 100 }, fakeJev, fakePi).run({ sessionId: 'demo' });
store.evaluation('demo000000000001', { description: 'Did the agent follow the requested documentation scope?', schedule: 'settled', every: 1, question: { type: 'noul', instructions: 'Did the agent follow the latest requested documentation target?' }, explanation: 'Fixture question for trying the dashboard controls.' });
store.close();
const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url)), root], { detached: true, stdio: 'ignore' });
daemon.unref();
let ready = false;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 100));
  try { await request(root, 'GET', '/status'); ready = true; break; } catch {}
}
if (!ready) throw new Error('Demo daemon did not start');
const { url } = await request(root, 'POST', '/open');
console.log(`Disposable project: ${root}\nDashboard: ${url}\nThis demo uses fake Jev/Pi answers and touches only the disposable project. Try Pause & rollback in the dashboard.`);
if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
