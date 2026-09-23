import { lstat, readFile, readdir, realpath, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep, dirname, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const dataDir = root => join(root, '.agent-watch');
export const socketPath = root => join(dataDir(root), 'run.sock');
export const settingsPath = root => join(dataDir(root), 'config.json');
const secret = /(Bearer\s+\S+|(?:sk|pk|ghp|gho|ghu|github_pat|AIza)[-_][A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|token|password|secret|aws[_-]?secret[_-]?access[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s"',}]{8,})/gi;
export function redact(value) {
  if (typeof value === 'string') return value.replace(secret, '[REDACTED]').replace(/(?:^|\s)(?:\/[^\s]+\/)?(?:\.env(?:\.\w+)?|auth\.json)(?=\s|$)/g, ' [EXCLUDED FILE]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /(?:authorization|api.?key|token|password|secret)/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
}
export function safeEvent(event) { return redact(JSON.parse(JSON.stringify(event))); }
export async function initProject(root, config = {}) {
  const dir = dataDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath(root), JSON.stringify({ consent: false, autonomous: false, maxDailyRequests: 100, maxTurnCostUsd: 1, maxTurnDurationMs: 180000, maxToolErrors: 3, windowExchanges: 20, ...config }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(dir, 'changes.md'), '# Agent Watch changes\n\n', { flag: 'a', mode: 0o600 });
}
export async function loadConfig(root) { return JSON.parse(await readFile(settingsPath(root), 'utf8')); }
export function isHarnessPath(path) {
  return path === 'AGENTS.md' || path === '.pi/settings.json' || /^\.pi\/(?:prompts\/[^/]+\.md|skills\/(?:[^/]+\/)*SKILL\.md|extensions\/(?:[^/]+\/)*[^/]+\.(?:js|ts))$/.test(path);
}
export async function safeFile(root, path) {
  if (!isHarnessPath(path) || path.split('/').includes('..')) throw new Error('File is outside the project harness');
  const base = await realpath(root);
  const absolute = resolve(base, path);
  if (!absolute.startsWith(base + sep)) throw new Error('Path escapes project');
  let current = base;
  for (const part of relative(base, absolute).split(sep)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current === absolute && !info.isFile())) throw new Error('Symlink or non-file harness path');
  }
  return absolute;
}
export async function inventory(root) {
  const paths = [];
  async function walk(dir, depth = 0) {
    if (depth > 5) return;
    for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const path = [dir, entry.name].filter(Boolean).join('/');
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (isHarnessPath(path)) paths.push(path);
    }
  }
  if (await safeFile(root, 'AGENTS.md').then(() => true).catch(() => false)) paths.push('AGENTS.md');
  await walk('.pi');
  return paths.sort();
}
export function windowOf(events, size = 20, sessionId, branchIds) {
  if (sessionId) events = events.filter(e => e.sessionId === sessionId && (!branchIds || !e.branchId || branchIds.includes(e.branchId)));
  size = Number.isInteger(size) ? Math.max(1, Math.min(size, 40)) : 20;
  const inputs = events.filter(e => e.kind === 'input').slice(-size);
  const start = inputs.length ? events.indexOf(inputs[0]) : 0;
  const span = events.slice(start);
  const allTurns = span.filter(e => e.kind === 'turn');
  const briefTurn = e => ({ ...e, response: e.response?.slice(0, 1200) });
  const turns = allTurns.filter(e => e.stopReason !== 'toolUse').slice(-40).map(briefTurn);
  const recentInputs = inputs.map(e => ({ ...e, text: e.text?.slice(0, 1200) }));
  const exchanges = inputs.map((input, i) => {
    const next = inputs[i + 1];
    const segment = events.slice(events.indexOf(input), next ? events.indexOf(next) : undefined);
    const used = segment.filter(e => e.kind === 'tool');
    return { input: recentInputs[i], turns: segment.filter(e => e.kind === 'turn' && e.stopReason !== 'toolUse').slice(-2).map(briefTurn), toolCount: used.length, toolErrors: used.filter(e => e.isError).length, toolNames: [...new Set(used.map(e => e.name))].slice(0, 40) };
  });
  // ponytail: preserve all 20 exchange summaries but cap detailed evidence; raise caps if large traces prove necessary.
  const tools = span.filter(e => e.kind === 'tool').slice(-120).map(e => ({ ...e, output: e.output?.slice(0, 500), arguments: e.arguments?.slice(0, 300) }));
  return { turns, allTurns, recentInputs, exchanges, tools, observedPaths: [...new Set(span.filter(e => e.kind === 'tool' && e.path).map(e => e.path))].slice(-200), context: events.filter(e => e.kind === 'session' && e.reason === 'context').at(-1) };
}
export async function jev(state, questions, { key = process.env.TYPESAFE_API_KEY, model = 'jev-latest', fetcher = fetch } = {}) {
  if (!key) throw new Error('TYPESAFE_API_KEY is required');
  const response = await fetcher('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const result = await response.json();
  for (const [name, question] of Object.entries(questions)) {
    const answer = result.answers?.[name];
    if (answer?.type !== question.type) throw new Error(`Invalid Jev answer: ${name}`);
    if (question.type === 'noul' && !(answer.noul >= 0 && answer.noul <= 1)) throw new Error('Invalid Noul probability');
    if (question.type === 'choice' && (!(answer.choice in question.criteria) || !Object.values(answer.probabilities ?? {}).every(n => n >= 0 && n <= 1))) throw new Error('Invalid Choice result');
    if (question.type === 'score' && !(answer.score >= 0 && answer.score <= question.criteria.length - 1)) throw new Error('Invalid Score result');
  }
  return result;
}
export function choice(instructions, options) { return { type: 'choice', instructions, criteria: Object.fromEntries(options.map(o => [o.id, o.description])) }; }
export function noul(instructions) { return { type: 'noul', instructions }; }
export function pick(answer, minimum = .65) {
  const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  return answer.choice !== 'none' && sorted[0]?.[0] === answer.choice && sorted[0][1] >= minimum && sorted[0][1] - (sorted[1]?.[1] ?? 0) >= .15 ? answer.choice : null;
}
export const directions = {
  skill: [{ id: 'narrow_trigger', description: 'Narrow when this skill is selected' }, { id: 'clarify_instructions', description: 'Clarify instructions inside the skill' }, { id: 'remove_conflict', description: 'Remove a conflicting or outdated skill instruction' }],
  instruction: [{ id: 'clarify_scope', description: 'Clarify the task or project scope' }, { id: 'remove_conflict', description: 'Remove conflicting instructions' }, { id: 'add_example', description: 'Add a concise example of correct behavior' }],
  prompt: [{ id: 'clarify_scope', description: 'Clarify when to use this prompt' }, { id: 'remove_conflict', description: 'Remove conflicting prompt instructions' }],
  extension: [{ id: 'fix_hook', description: 'Fix the observed extension hook behavior' }, { id: 'narrow_effect', description: 'Narrow this extension’s effect on the session' }],
  setting: [{ id: 'adjust_setting', description: 'Adjust the observed Pi setting' }],
};
export function component(path) { return path.includes('/skills/') ? 'skill' : path.includes('/prompts/') ? 'prompt' : path.includes('/extensions/') ? 'extension' : path.endsWith('settings.json') ? 'setting' : 'instruction'; }
export async function atomicWrite(path, content) {
  const temp = join(dirname(path), `.agent-watch-${randomUUID()}${extname(path)}`);
  try { await writeFile(temp, content, { mode: (await lstat(path)).mode & 0o777, flag: 'wx' }); await rename(temp, path); }
  finally { const { unlink } = await import('node:fs/promises'); await unlink(temp).catch(() => {}); }
}
export function validCandidate(path, content) {
  if (typeof content !== 'string' || !content.trim() || content.length > 32000) return false;
  if (path.endsWith('.json')) { try { const value = JSON.parse(content); return value && typeof value === 'object' && !Array.isArray(value); } catch { return false; } }
  if (/\.(?:js|ts)$/.test(path)) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-watch-check-'));
    try {
      const file = join(dir, `candidate${extname(path)}`); writeFileSync(file, content);
      return spawnSync(process.execPath, ['--check', file], { timeout: 5000, stdio: 'ignore' }).status === 0;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return true;
}
export function unifiedDiff(path, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-watch-diff-'));
  try {
    writeFileSync(join(dir, 'before'), before); writeFileSync(join(dir, 'after'), after);
    const result = spawnSync('diff', ['-u', '--label', `a/${path}`, '--label', `b/${path}`, join(dir, 'before'), join(dir, 'after')], { encoding: 'utf8', maxBuffer: 100000 });
    if (result.error || result.status !== 1) throw result.error ?? new Error('Diff failed');
    return result.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export async function appendLedger(root, text) {
  const file = join(dataDir(root), 'changes.md');
  const handle = await open(file, 'a', 0o600);
  try { await handle.write(text); await handle.sync(); } finally { await handle.close(); }
}
