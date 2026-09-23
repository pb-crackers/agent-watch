import { appendFile, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { request } from '../src/daemon.mjs';
import { safeEvent, settingsPath, dataDir } from '../src/core.mjs';

export default function (pi) {
  let root, enabled = false, flushing = false, turnStarted = Date.now();
  async function send(e) {
    if (!enabled) return;
    e = safeEvent({ id: randomUUID(), at: new Date().toISOString(), ...e });
    try {
      await request(root, 'POST', '/event', e);
      if (!flushing && existsSync(join(dataDir(root), 'spool.jsonl'))) {
        flushing = true; void flush().finally(() => { flushing = false; });
      }
    } catch { await appendFile(join(dataDir(root), 'spool.jsonl'), JSON.stringify(e) + '\n', { mode: 0o600 }).catch(() => {}); }
  }
  async function flush() {
    const file = join(dataDir(root), 'spool.jsonl'), pending = file + '.pending';
    const interrupted = await readFile(pending, 'utf8').catch(() => '');
    if (interrupted) { await appendFile(file, interrupted, { mode: 0o600 }); await unlink(pending); }
    try { await rename(file, pending); } catch { return; }
    const lines = (await readFile(pending, 'utf8')).trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      try { await request(root, 'POST', '/event', JSON.parse(lines[i])); }
      catch { await appendFile(file, lines.slice(i).join('\n') + '\n', { mode: 0o600 }); break; }
    }
    await unlink(pending).catch(() => {});
  }
  pi.on('session_start', async (_event, ctx) => {
    root = ctx.cwd;
    enabled = existsSync(settingsPath(root));
    if (!enabled) return;
    try { await request(root, 'GET', '/status'); }
    catch { spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url)), root], { detached: true, stdio: 'ignore' }).unref(); }
    await flush();
    await send({ kind: 'session', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), reason: 'start' });
  });
  pi.on('input', (event, ctx) => { if (event.source !== 'extension') void send({ kind: 'input', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), text: event.text.slice(0, 4000) }); });
  pi.on('before_agent_start', (event, ctx) => {
    const options = event.systemPromptOptions;
    void send({ kind: 'session', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), reason: 'context', activeTools: options.selectedTools, availableSkills: options.skills?.map(s => s.filePath), contextFiles: options.contextFiles?.map(f => f.path), extensionFiles: pi.getAllTools().filter(t => options.selectedTools?.includes(t.name)).map(t => t.sourceInfo?.path).filter(Boolean) });
  });
  pi.on('tool_execution_end', (event, ctx) => {
    const args = JSON.stringify(event.args ?? {}).slice(0, 1000);
    const sensitive = /(?:\.env(?:\.[\w-]+)?|auth\.json|id_rsa|id_ed25519)/i.test(args);
    void send({ kind: 'tool', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), name: event.toolName, isError: event.isError, arguments: sensitive ? '[EXCLUDED FILE]' : args, path: !sensitive && event.toolName === 'read' ? event.args?.path : undefined, output: sensitive ? '[EXCLUDED FILE]' : event.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1000) });
  });
  pi.on('turn_start', () => { turnStarted = Date.now(); });
  pi.on('turn_end', (event, ctx) => {
    const message = event.message;
    const response = message?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 4000) ?? '';
    const tools = (event.toolResults ?? []).map(r => ({ name: r.toolName, isError: r.isError }));
    void send({ kind: 'turn', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), response, tools, costUsd: message?.usage?.cost?.total ?? 0, durationMs: Date.now() - turnStarted, stopReason: message?.stopReason });
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!enabled) return;
    void send({ kind: 'session', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), reason: 'settled', branchIds: ctx.sessionManager.getBranch().map(e => e.id) });
    if (!ctx.hasUI) return;
    try { const s = await request(root, 'GET', '/status'); ctx.ui.setStatus('agent-watch', s.paused ? 'watch paused' : s.active ? 'watch: change under review' : 'watching'); }
    catch { ctx.ui.setStatus('agent-watch', 'watch offline'); }
  });
  pi.on('session_shutdown', async (_event, ctx) => { if (enabled) await send({ kind: 'session', sessionId: ctx.sessionManager.getSessionId(), branchId: ctx.sessionManager.getLeafId(), reason: 'shutdown' }); });
  for (const [name, method, path] of [['watch-status', 'GET', '/status'], ['watch-review', 'GET', '/status'], ['watch-pause', 'POST', '/pause'], ['watch-resume', 'POST', '/resume'], ['watch-rollback', 'POST', '/rollback'], ['watch-open', 'POST', '/open']]) {
    pi.registerCommand(name, { description: `Agent Watch ${name.slice(6)}`, handler: async (_args, ctx) => {
      if (!enabled) return ctx.ui.notify('Run agent-watch setup in this project first', 'warning');
      try { const result = await request(root, method, path); ctx.ui.notify(name === 'watch-open' ? result.url : name === 'watch-review' ? JSON.stringify(result.changes?.[0] ?? 'No changes') : name === 'watch-status' ? `Agent Watch: ${result.paused ? 'paused' : 'running'}` : `${name}: done`, 'info'); }
      catch (e) { ctx.ui.notify(e.message, 'error'); }
    } });
  }
}
