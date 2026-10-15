/*
 * Vertiv 제품 선정 지원 시스템 — 로컬 서버 (외부 패키지 없음)
 *   실행:  node server.js   →  http://localhost:3000
 *   - 정적 파일 제공
 *   - POST /api/claude : Claude Messages API 프록시 (API 키는 서버의 .env 에만 보관)
 *   - GET  /api/status : 서버 설정 상태
 *   - /api/comparisons : 저장된 비교 목록 CRUD
 *       · .env 에 SUPABASE_URL + SUPABASE_KEY 가 있으면 Supabase(PostgreSQL)
 *       · 없으면 로컬 SQLite (data/vss.db)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

// .env 로드 (KEY=VALUE 형식)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (e) { /* .env 없음 */ }

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
// publishable 키(sb_publishable_)는 supabase/schema.sql 의 anon 정책이 있어야 동작, secret 키는 정책과 무관하게 동작
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const NOT_FOUND = Object.assign(new Error('저장된 비교를 찾을 수 없습니다.'), { status: 404 });

/* ======================= 저장소: Supabase ======================= */
function supabaseRepo() {
  const base = `${SUPABASE_URL}/rest/v1/comparisons`;
  const headers = { apikey: SUPABASE_KEY, 'content-type': 'application/json' };
  // 기존 JWT 형식 키(service_role)는 Authorization 헤더도 필요, 새 sb_secret_ 키는 apikey 헤더만 사용
  if (SUPABASE_KEY.startsWith('eyJ')) headers.authorization = `Bearer ${SUPABASE_KEY}`;
  const LIST_COLS = 'id,name,customer,site,summary,created_at,updated_at';
  const out = (r, withData) => ({
    id: r.id, name: r.name, customer: r.customer, site: r.site, summary: r.summary,
    createdAt: r.created_at, updatedAt: r.updated_at, ...(withData ? { data: r.data } : {}),
  });
  async function call(method, query, body) {
    const r = await fetch(`${base}?${query}`, {
      method, headers: { ...headers, ...(method === 'GET' ? {} : { prefer: 'return=representation' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text; try { msg = JSON.parse(text).message || text; } catch (e) { }
      if (/relation .* does not exist|Could not find the table/i.test(msg)) msg = 'Supabase에 comparisons 테이블이 없습니다. supabase/schema.sql 을 SQL Editor에서 실행하세요.';
      else if (/row-level security|permission denied/i.test(msg)) msg = '접근 권한이 없습니다. supabase/schema.sql 의 정책(policy)까지 실행했는지 확인하세요. (' + msg + ')';
      throw Object.assign(new Error('Supabase 오류: ' + msg), { status: 502 });
    }
    return text ? JSON.parse(text) : [];
  }
  return {
    kind: 'supabase',
    async list() { return (await call('GET', `select=${LIST_COLS}&order=updated_at.desc`)).map(r => out(r)); },
    async get(id) { const [r] = await call('GET', `select=*&id=eq.${id}`); if (!r) throw NOT_FOUND; return out(r, true); },
    async create(rec) { const [r] = await call('POST', `select=${LIST_COLS}`, rec); return out(r); },
    async update(id, rec) {
      const [r] = await call('PATCH', `id=eq.${id}&select=${LIST_COLS}`, { ...rec, updated_at: new Date().toISOString() });
      if (!r) throw NOT_FOUND; return out(r);
    },
    async remove(id) { const rows = await call('DELETE', `id=eq.${id}&select=id`); if (!rows.length) throw NOT_FOUND; },
  };
}

/* ======================= 저장소: SQLite ======================= */
function sqliteRepo() {
  const { DatabaseSync } = require('node:sqlite');
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
  const out = (r, withData) => ({
    id: r.id, name: r.name, customer: r.customer, site: r.site, summary: JSON.parse(r.summary),
    createdAt: r.created_at, updatedAt: r.updated_at, ...(withData ? { data: JSON.parse(r.data) } : {}),
  });
  const vals = rec => [rec.name, rec.customer, rec.site, JSON.stringify(rec.summary), JSON.stringify(rec.data)];
  return {
    kind: 'sqlite',
    async list() { return sql.list.all().map(r => out(r)); },
    async get(id) { const r = sql.get.get(id); if (!r) throw NOT_FOUND; return out(r, true); },
    async create(rec) {
      const now = new Date().toISOString();
      const { lastInsertRowid } = sql.insert.run(...vals(rec), now, now);
      return out(sql.get.get(Number(lastInsertRowid)));
    },
    async update(id, rec) {
      if (!sql.update.run(...vals(rec), new Date().toISOString(), id).changes) throw NOT_FOUND;
      return out(sql.get.get(id));
    },
    async remove(id) { if (!sql.remove.run(id).changes) throw NOT_FOUND; },
  };
}

const repo = SUPABASE_URL && SUPABASE_KEY ? supabaseRepo() : sqliteRepo();

/* ============================ HTTP ============================ */
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
    if (req.method === 'GET') return send(res, 200, id == null ? await repo.list() : await repo.get(id));
    if (req.method === 'DELETE' && id != null) { await repo.remove(id); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' || (req.method === 'PUT' && id != null)) {
      const b = JSON.parse(await readBody(req));
      if (!b.name || !b.data || !b.summary) return send(res, 400, { error: { message: 'name, summary, data가 필요합니다.' } });
      const rec = { name: String(b.name).slice(0, 200), customer: b.customer || '', site: b.site || '', summary: b.summary, data: b.data };
      return req.method === 'POST' ? send(res, 201, await repo.create(rec)) : send(res, 200, await repo.update(id, rec));
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

const BLOCKED_DIRS = [DATA_DIR, path.join(ROOT, 'supabase')];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/status') return send(res, 200, { serverKey: !!API_KEY, storage: repo.kind });
  if (url.pathname === '/api/claude' && req.method === 'POST') return proxyClaude(req, res);
  const cm = url.pathname.match(/^\/api\/comparisons(?:\/(\d+))?\/?$/);
  if (cm) return comparisonsApi(req, res, cm[1] ? Number(cm[1]) : null);

  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  if (!file.startsWith(ROOT) || BLOCKED_DIRS.some(d => file.startsWith(d)) || path.basename(file).startsWith('.') || file.endsWith('server.js')) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}).listen(PORT, () => {
  console.log(`Vertiv 제품 선정 지원 시스템: http://localhost:${PORT}`);
  console.log('저장소: ' + (repo.kind === 'supabase' ? `Supabase (${SUPABASE_URL})` : 'SQLite (data/vss.db)' +
    (SUPABASE_URL && !SUPABASE_KEY ? ' — SUPABASE_KEY가 없어 Supabase 대신 사용 중' : '')));
  console.log(API_KEY ? 'Claude API 키: 서버(.env)에서 로드됨' : 'Claude API: 미사용(데모 모드)');
});
