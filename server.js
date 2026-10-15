/*
 * Vertiv 제품 선정 지원 시스템 — 로컬 서버 (외부 패키지 없음)
 *   실행:  node server.js   →  http://localhost:3000
 *   - 정적 파일 제공
 *   - POST /api/claude : Claude Messages API 프록시 (API 키는 서버의 .env 에만 보관)
 *   - GET  /api/status : 서버 키 설정 여부
 *   - /api/comparisons : 저장된 비교 목록 CRUD (SQLite: data/vss.db)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(ROOT, 'data');

// ---- SQLite
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'vss.db'));
db.exec(`CREATE TABLE IF NOT EXISTS comparisons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  customer   TEXT,
  site       TEXT,
  summary    TEXT NOT NULL,   -- 목록 표시용 JSON
  data       TEXT NOT NULL,   -- 전체 스냅샷 JSON (요구사항·결과·선택·영업 메시지)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
const sql = {
  list: db.prepare('SELECT id, name, customer, site, summary, created_at, updated_at FROM comparisons ORDER BY updated_at DESC'),
  get: db.prepare('SELECT * FROM comparisons WHERE id = ?'),
  insert: db.prepare('INSERT INTO comparisons (name, customer, site, summary, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE comparisons SET name = ?, customer = ?, site = ?, summary = ?, data = ?, updated_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM comparisons WHERE id = ?'),
};
const rowOut = (r, withData) => ({
  id: r.id, name: r.name, customer: r.customer, site: r.site, summary: JSON.parse(r.summary),
  createdAt: r.created_at, updatedAt: r.updated_at, ...(withData ? { data: JSON.parse(r.data) } : {}),
});

// .env 로드 (KEY=VALUE 형식)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* .env 없음 */ }

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req, limit = 5e6) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }); }
  return raw;
}

async function comparisonsApi(req, res, id) {
  try {
    if (req.method === 'GET' && id == null) return send(res, 200, sql.list.all().map(r => rowOut(r)));
    if (req.method === 'GET') {
      const r = sql.get.get(id);
      return r ? send(res, 200, rowOut(r, true)) : send(res, 404, { error: { message: '저장된 비교를 찾을 수 없습니다.' } });
    }
    if (req.method === 'DELETE' && id != null) {
      const { changes } = sql.remove.run(id);
      return send(res, changes ? 200 : 404, { ok: !!changes });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const b = JSON.parse(await readBody(req));
      if (!b.name || !b.data || !b.summary) return send(res, 400, { error: { message: 'name, summary, data가 필요합니다.' } });
      const now = new Date().toISOString();
      const vals = [String(b.name).slice(0, 200), b.customer || '', b.site || '', JSON.stringify(b.summary), JSON.stringify(b.data)];
      if (req.method === 'POST') {
        const { lastInsertRowid } = sql.insert.run(...vals, now, now);
        return send(res, 201, rowOut(sql.get.get(Number(lastInsertRowid))));
      }
      const { changes } = sql.update.run(...vals, now, id);
      return changes ? send(res, 200, rowOut(sql.get.get(id))) : send(res, 404, { error: { message: '저장된 비교를 찾을 수 없습니다.' } });
    }
    send(res, 405, { error: { message: 'Method not allowed' } });
  } catch (e) {
    send(res, e.status || 400, { error: { message: e.message } });
  }
}

async function proxyClaude(req, res) {
  if (!API_KEY) return send(res, 500, { error: { message: '서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다.' } });
  let raw;
  try { raw = await readBody(req, 2e6); } catch (e) { return send(res, 413, { error: { message: e.message } }); }
  const headers = { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' };
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: raw });
    send(res, r.status, await r.text());
  } catch (e) {
    send(res, 502, { error: { message: 'Claude API 연결 실패: ' + e.message } });
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') return send(res, 200, { serverKey: !!API_KEY });
  if (url.pathname === '/api/claude' && req.method === 'POST') return proxyClaude(req, res);
  const cm = url.pathname.match(/^\/api\/comparisons(?:\/(\d+))?\/?$/);
  if (cm) return comparisonsApi(req, res, cm[1] ? Number(cm[1]) : null);

  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(ROOT) || file.startsWith(DATA_DIR) || path.basename(file).startsWith('.') || file.endsWith('server.js')) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}).listen(PORT, () => {
  console.log(`Vertiv 제품 선정 지원 시스템: http://localhost:${PORT}`);
  console.log(API_KEY ? 'Claude API 키: 서버(.env)에서 로드됨' : 'Claude API 키 없음 → 데모 모드 또는 설정 화면에서 브라우저 키 입력');
});
