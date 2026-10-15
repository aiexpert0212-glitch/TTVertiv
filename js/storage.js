/*
 * 저장된 비교 저장소
 *   - node server.js 로 실행 중이면 서버 SQLite DB(/api/comparisons) 사용
 *   - index.html 을 직접 연 경우 브라우저 localStorage 사용 (이 PC·이 브라우저에서만 보임)
 */
window.VSS = window.VSS || {};

VSS.storage = (function () {
  const LS_KEY = 'vss.saved';
  let mode = null; // 'server' | 'local'
  let kind = null; // 서버 저장소 종류: 'supabase' | 'sqlite'
  let detecting = null; // 동시 호출 시 같은 판별 결과를 공유

  function detect() {
    if (!detecting) detecting = (async () => {
      let m = 'local';
      if (/^https?:/.test(location.protocol)) {
        try {
          const r = await fetch('/api/status');
          if (r.ok) { const s = await r.json(); if (s.storage) { m = 'server'; kind = s.storage; } }
        } catch (e) { }
      }
      return (mode = m);
    })();
    return detecting;
  }

  async function api(method, path = '', body) {
    const r = await fetch('/api/comparisons' + path, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data.error && data.error.message) || '저장소 오류 (' + r.status + ')');
    return data;
  }

  const local = {
    all() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; } },
    write(list) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
      catch (e) { throw new Error('브라우저 저장 공간이 부족하거나 저장이 차단되었습니다.'); }
    },
  };
  const strip = ({ data, ...meta }) => meta;

  return {
    detect,
    get mode() { return mode; },
    get kind() { return kind; },
    async list() {
      if ((await detect()) === 'server') return api('GET');
      return local.all().map(strip).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      if ((await detect()) === 'server') return api('GET', '/' + id);
      const rec = local.all().find(x => x.id === id);
      if (!rec) throw new Error('저장된 비교를 찾을 수 없습니다.');
      return rec;
    },
    async create(rec) {
      if ((await detect()) === 'server') return api('POST', '', rec);
      const list = local.all(), now = new Date().toISOString();
      const item = { ...rec, id: Date.now(), createdAt: now, updatedAt: now };
      list.push(item); local.write(list);
      return strip(item);
    },
    async update(id, rec) {
      if ((await detect()) === 'server') return api('PUT', '/' + id, rec);
      const list = local.all(), i = list.findIndex(x => x.id === id);
      if (i < 0) throw new Error('저장된 비교를 찾을 수 없습니다.');
      list[i] = { ...list[i], ...rec, updatedAt: new Date().toISOString() }; local.write(list);
      return strip(list[i]);
    },
    async remove(id) {
      if ((await detect()) === 'server') return api('DELETE', '/' + id);
      local.write(local.all().filter(x => x.id !== id));
      return { ok: true };
    },
  };
})();
