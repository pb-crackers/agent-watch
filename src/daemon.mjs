import http from 'node:http';
import { readFile, unlink, stat, appendFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dataDir, loadConfig, redact, safeEvent, socketPath } from './core.mjs';
import { Store } from './store.mjs';
import { DecisionTree } from './tree.mjs';
import { compileEvaluation, runEvaluations, runSignals } from './evals.mjs';

function validEvaluation(def) {
  const q = def?.question, criteria = q?.criteria;
  return typeof def?.description === 'string' && !!def.description.trim() && def.description.length <= 2000 &&
    ['turn','settled','shutdown'].includes(def.schedule) && Number.isInteger(def.every) && def.every >= 1 && def.every <= 100 &&
    ['noul','choice','score'].includes(q?.type) && typeof q.instructions === 'string' && !!q.instructions.trim() && q.instructions.length <= 500 &&
    (q.type === 'noul' || q.type === 'choice' && criteria && typeof criteria === 'object' && !Array.isArray(criteria) && Object.keys(criteria).length >= 2 && Object.keys(criteria).length <= 8 && Object.values(criteria).every(v => typeof v === 'string') || q.type === 'score' && Array.isArray(criteria) && criteria.length >= 2 && criteria.length <= 5 && criteria.every(v => typeof v === 'string'));
}

export async function start(root) {
  root = resolve(root);
  const config = await loadConfig(root);
  const store = new Store(root);
  const socket = socketPath(root);
  let queue = Promise.resolve(), server, token, tokenExpires = 0, lastTurn = '';
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const status = () => ({ paused: config.paused ?? false, consent: config.consent, autonomous: config.autonomous, active: store.active() && { id: store.active().id, path: store.active().path, status: 'watching' }, changes: store.changes(), decisions: store.decisions(15).map(d => ({ at: d.at, gate: d.gate, response: d.response })), events: store.events(40), evaluations: store.evaluations() });
  const onRequest = async (req, res, web = false) => {
    const url = new URL(req.url, 'http://localhost');
    if (web && (Date.now() > tokenExpires || req.headers['x-watch-token'] !== token || req.headers.origin && req.headers.origin !== `http://127.0.0.1:${server.address().port}`)) return send(res, 403, { error: 'Forbidden' });
    try {
      if (web && req.method === 'GET' && url.pathname === '/') {
        const html = await readFile(new URL('./web.html', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'" }); res.end(html); return;
      }
      if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, status());
      if (req.method === 'POST' && url.pathname === '/open' && !web) {
        if (!server) { server = http.createServer((r, s) => { if (r.url?.startsWith('/?token=')) { if (new URL(r.url, 'http://localhost').searchParams.get('token') !== token) return send(s, 403, { error: 'Forbidden' }); r.headers['x-watch-token'] = token; } onRequest(r, s, true); }); await new Promise(r => server.listen(0, '127.0.0.1', r)); }
        token = randomBytes(24).toString('hex'); tokenExpires = Date.now() + 30 * 60 * 1000;
        return send(res, 200, { url: `http://127.0.0.1:${server.address().port}/?token=${token}` });
      }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) throw new Error('Payload too large'); }
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === 'POST' && url.pathname === '/event') {
        if (!body.id || !body.sessionId || !['input', 'turn', 'tool', 'session'].includes(body.kind)) return send(res, 400, { error: 'Invalid event' });
        const event = safeEvent({ ...body, at: body.at ?? new Date().toISOString() });
        const inserted = store.event(event);
        if (inserted && (event.kind === 'turn' || event.kind === 'session' && ['settled', 'shutdown'].includes(event.reason)) && event.id !== lastTurn && !config.paused && config.consent) {
          lastTurn = event.id;
          queue = queue.then(async () => {
            const today = new Date().toISOString().slice(0, 10);
            if (store.decisions(1000).filter(d => d.at.startsWith(today)).length >= config.maxDailyRequests) return;
            if (event.kind === 'session' && event.reason === 'settled') await runSignals(store, config, event);
            await runEvaluations(store, config, event);
            if (event.kind === 'session' && event.reason === 'settled' && config.autonomous) await new DecisionTree(root, store, config).run(event);
          }).catch(e => console.error('Agent Watch evaluation failed:', e.message));
        }
        return send(res, 202, { accepted: true });
      }
      if (req.method === 'POST' && url.pathname === '/pause') {
        config.paused = true; await saveConfig();
        await queue;
        const active = store.active(); if (active) await new DecisionTree(root, store, config).rollback(active, 'Emergency pause');
        return send(res, 200, status());
      }
      if (req.method === 'POST' && url.pathname === '/resume') { config.paused = false; await saveConfig(); return send(res, 200, status()); }
      if (req.method === 'POST' && url.pathname === '/rollback') {
        const active = store.active(); if (!active) return send(res, 409, { error: 'No active change' });
        await queue;
        return send(res, 200, { rolledBack: await new DecisionTree(root, store, config).rollback(active, 'User rollback') });
      }
      if (req.method === 'POST' && url.pathname === '/eval/compile') {
        if (typeof body.description !== 'string' || !body.description.trim()) return send(res, 400, { error: 'Description required' });
        return send(res, 200, await compileEvaluation(root, body.description, body.schedule, body.every));
      }
      if (req.method === 'POST' && url.pathname === '/eval/activate') {
        const def = redact(body.definition);
        if (!validEvaluation(def)) return send(res, 400, { error: 'Invalid evaluation' });
        const id = randomBytes(8).toString('hex'); store.evaluation(id, { ...def, created: new Date().toISOString() }); return send(res, 201, { id });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/eval/')) {
        if (!/^[a-f0-9]{16}$/.test(body.id)) return send(res, 400, { error: 'Invalid evaluation ID' });
        if (url.pathname === '/eval/update') {
          const def = redact(body.definition);
          if (!validEvaluation(def)) return send(res, 400, { error: 'Invalid evaluation' });
          return send(res, store.updateEvaluation(body.id, def) ? 200 : 404, { id: body.id });
        }
        if (url.pathname === '/eval/toggle' && typeof body.enabled === 'boolean') return send(res, store.toggleEvaluation(body.id, body.enabled) ? 200 : 404, { id: body.id, enabled: body.enabled });
        if (url.pathname === '/eval/remove') return send(res, store.removeEvaluation(body.id) ? 200 : 404, { id: body.id });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  };
  async function saveConfig() { const { writeFile } = await import('node:fs/promises'); await writeFile(join(dataDir(root), 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); }
  // An existing live socket belongs to another daemon; only remove stale sockets.
  if (await stat(socket).then(() => true).catch(() => false)) {
    try { await request(root, 'GET', '/status'); throw new Error('Agent Watch is already running'); }
    catch (e) { if (e.message === 'Agent Watch is already running') throw e; await unlink(socket); }
  }
  const listener = http.createServer((req, res) => onRequest(req, res));
  await new Promise((yes, no) => listener.once('error', no).listen(socket, yes));
  await chmod(socket, 0o600);
  // Recover interrupted apply without overwriting files changed by the user.
  for (const row of store.db.prepare("SELECT * FROM changes WHERE status = 'applying'").all()) {
    const { safeFile, hash } = await import('./core.mjs');
    try {
      const content = await readFile(await safeFile(root, row.path), 'utf8');
      store.updateChange(row.id, content === row.after ? 'watching' : content === row.before ? 'failed' : 'conflict', JSON.parse(row.detail));
    } catch { store.updateChange(row.id, 'conflict', JSON.parse(row.detail)); }
  }
  const close = () => { listener.close(); server?.close(); store.close(); unlink(socket).catch(() => {}); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  return { close, listener };
}

export function request(root, method, path, body) {
  return new Promise((done, reject) => {
    const req = http.request({ socketPath: socketPath(resolve(root)), path, method, headers: { 'content-type': 'application/json' }, timeout: path === '/eval/compile' ? 65000 : 3000 }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { const value = JSON.parse(data); res.statusCode >= 400 ? reject(new Error(value.error)) : done(value); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('Agent Watch timed out')));
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) start(process.argv[2] ?? process.cwd()).catch(e => { console.error(e.message); process.exitCode = 1; });
