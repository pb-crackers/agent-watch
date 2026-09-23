#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, loadConfig, settingsPath } from './core.mjs';
import { createInterface } from 'node:readline/promises';
import { request, start } from './daemon.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
const projectIndex = args.indexOf('--project');
if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project requires a path');
const root = resolve(projectIndex >= 0 ? args[projectIndex + 1] : process.cwd());
async function ensure() {
  try { return await request(root, 'GET', '/status'); }
  catch {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.mjs', import.meta.url)), root], { detached: true, stdio: 'ignore' }); child.unref();
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 100)); try { return await request(root, 'GET', '/status'); } catch {} }
    throw new Error('Daemon did not start; run agent-watch daemon to see why');
  }
}
async function main() {
  if (command === 'setup') {
    if (existsSync(settingsPath(root))) throw new Error('Already configured; edit .agent-watch/config.json or use status');
    let consent = args.includes('--consent'), autonomous = args.includes('--autonomous');
    if (process.stdin.isTTY && !consent && !autonomous) {
      const ui = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log('Agent Watch observes redacted Pi conversations, tool outcomes, and project-local harness files.');
        console.log('It sends recent redacted evidence and candidate diffs to Jev. Headless Pi drafts edits with no tools.');
        console.log('Autonomous mode may change project-local AGENTS.md and .pi settings, skills, prompts, and extensions; prior contents are saved for rollback.');
        consent = /^y(es)?$/i.test(await ui.question('Allow this project to send redacted evaluation state to Jev? [y/N] '));
        autonomous = consent && !/^n(o)?$/i.test(await ui.question('Enable autonomous harness changes after Jev selection? [Y/n] '));
      } finally { ui.close(); }
    }
    if (autonomous && !consent) throw new Error('Autonomous mode requires explicit Jev consent (--consent)');
    await initProject(root, { consent, autonomous });
    console.log(`Configured ${root}. Jev ${consent ? 'enabled' : 'disabled'}; autonomous changes ${autonomous ? 'enabled' : 'disabled'}.`);
    console.log('Export TYPESAFE_API_KEY and try the checked-out extension with pi -e /absolute/path/to/agent-watch/extensions/agent-watch.js, then run agent-watch open.');
    if (!consent || !autonomous) console.log('To change consent or autonomy later, edit .agent-watch/config.json and restart the local daemon.');
    return;
  }
  if (command === 'daemon') return start(root);
  await loadConfig(root);
  await ensure();
  if (command === 'open') {
    const { url } = await request(root, 'POST', '/open');
    console.log(url);
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const routes = { status: ['GET', '/status'], sessions: ['GET', '/status'], changes: ['GET', '/status'], review: ['GET', '/status'], evals: ['GET', '/status'], pause: ['POST', '/pause'], resume: ['POST', '/resume'], rollback: ['POST', '/rollback'] };
  if (command === 'eval-add' || command === 'eval-edit') {
    const option = name => args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined;
    const id = command === 'eval-edit' ? args[0] : undefined;
    if (id && !/^[a-f0-9]{16}$/.test(id)) throw new Error('Usage: agent-watch eval-edit <id> "new question"');
    const existing = id && (await request(root, 'GET', '/status')).evaluations.find(e => e.id === id);
    if (id && !existing) throw new Error('Evaluation not found');
    const description = args.filter((_, i) => (command !== 'eval-edit' || i !== 0) && !['--project','--schedule','--every'].includes(args[i - 1]) && !['--project','--schedule','--every'].includes(args[i])).join(' ').trim();
    if (!description) throw new Error('Usage: agent-watch eval-add "question" or eval-edit <id> "new question" [--schedule turn|settled|shutdown] [--every N]');
    const definition = await request(root, 'POST', '/eval/compile', { description, schedule: option('--schedule') ?? existing?.schedule ?? 'settled', every: Number(option('--every') ?? existing?.every ?? 1) });
    console.log('Proposed evaluation:\n' + JSON.stringify(definition, null, 2));
    if (!process.stdin.isTTY) { console.log('Not activated: run interactively to confirm this question.'); return; }
    const ui = createInterface({ input: process.stdin, output: process.stdout });
    let approved; try { approved = /^y(es)?$/i.test(await ui.question(id ? 'Replace this evaluation? [y/N] ' : 'Activate this evaluation? [y/N] ')); } finally { ui.close(); }
    if (approved) console.log(JSON.stringify(await request(root, 'POST', id ? '/eval/update' : '/eval/activate', { id, definition }), null, 2));
    return;
  }
  if (['eval-enable','eval-disable','eval-remove'].includes(command)) {
    const id = args[0]; if (!/^[a-f0-9]{16}$/.test(id)) throw new Error(`Usage: agent-watch ${command} <id>`);
    if (command === 'eval-remove' && !args.includes('--yes')) throw new Error('Pass --yes to permanently remove this evaluation (past run history remains)');
    const path = command === 'eval-remove' ? '/eval/remove' : '/eval/toggle';
    console.log(JSON.stringify(await request(root, 'POST', path, { id, enabled: command === 'eval-enable' }), null, 2)); return;
  }
  if (!routes[command]) throw new Error('Commands: setup, daemon, open, status, sessions, changes, review, evals, eval-add, eval-edit, eval-enable, eval-disable, eval-remove, pause, resume, rollback');
  const [method, path] = routes[command]; const value = await request(root, method, path);
  console.log(JSON.stringify(command === 'sessions' ? value.events : command === 'changes' || command === 'review' ? value.changes : command === 'evals' ? value.evaluations : value, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
