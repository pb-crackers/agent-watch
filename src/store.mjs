import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { dataDir, unifiedDiff } from './core.mjs';

export class Store {
  constructor(root) {
    this.db = new DatabaseSync(join(dataDir(root), 'data.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session, at);
      CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY, at TEXT NOT NULL, gate TEXT NOT NULL, state_hash TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, path TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, base_hash TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, definition TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
    `);
  }
  event(e) { return this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)').run(e.id, e.sessionId, e.kind, e.at, JSON.stringify(e)).changes > 0; }
  events(limit = 100) { return this.db.prepare('SELECT data FROM events ORDER BY rowid DESC LIMIT ?').all(limit).reverse().map(r => JSON.parse(r.data)); }
  recentExchanges(sessionId, count = 20) {
    count = Number.isInteger(count) ? Math.max(1, Math.min(count, 40)) : 20;
    const boundary = this.db.prepare("SELECT rowid FROM events WHERE session = ? AND kind = 'input' ORDER BY rowid DESC LIMIT 1 OFFSET ?").get(sessionId, count - 1)?.rowid ?? 0;
    return this.db.prepare('SELECT data FROM events WHERE session = ? AND rowid >= ? ORDER BY rowid').all(sessionId, boundary).map(r => JSON.parse(r.data));
  }
  countTurns(sessionId) { return this.db.prepare("SELECT count(*) AS count FROM events WHERE session = ? AND kind = 'turn'").get(sessionId).count; }
  decision(gate, stateHash, request, response) { this.db.prepare('INSERT INTO decisions (at, gate, state_hash, request, response) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), gate, stateHash, JSON.stringify(request), JSON.stringify(response)); }
  decisions(limit = 30) { return this.db.prepare('SELECT at, gate, state_hash, request, response FROM decisions ORDER BY id DESC LIMIT ?').all(limit).map(r => ({ ...r, request: JSON.parse(r.request), response: JSON.parse(r.response) })); }
  change(change) { this.db.prepare('INSERT INTO changes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(change.id, change.path, change.before, change.after, change.baseHash, change.status, change.at, JSON.stringify(change.detail)); }
  updateChange(id, status, detail) { this.db.prepare('UPDATE changes SET status=?, detail=? WHERE id=?').run(status, JSON.stringify(detail), id); }
  active() { const r = this.db.prepare("SELECT * FROM changes WHERE status = 'watching' LIMIT 1").get(); return r && { ...r, detail: JSON.parse(r.detail) }; }
  changes(limit = 20) { return this.db.prepare('SELECT id, path, before, after, status, at, detail FROM changes ORDER BY at DESC LIMIT ?').all(limit).map(({ before, after, ...r }) => ({ ...r, detail: JSON.parse(r.detail), diff: unifiedDiff(r.path, before, after) })); }
  evaluation(id, definition) { this.db.prepare('INSERT INTO evaluations VALUES (?, ?, 1)').run(id, JSON.stringify(definition)); }
  evaluations() { return this.db.prepare('SELECT * FROM evaluations').all().map(r => ({ id: r.id, ...JSON.parse(r.definition), enabled: !!r.enabled })); }
  toggleEvaluation(id, enabled) { return this.db.prepare('UPDATE evaluations SET enabled=? WHERE id=?').run(+enabled, id).changes > 0; }
  updateEvaluation(id, definition) { return this.db.prepare('UPDATE evaluations SET definition=? WHERE id=?').run(JSON.stringify(definition), id).changes > 0; }
  removeEvaluation(id) { return this.db.prepare('DELETE FROM evaluations WHERE id=?').run(id).changes > 0; }
  close() { this.db.close(); }
}
