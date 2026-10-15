/* 화면 렌더링 · 라우팅 */
(function () {
  const E = VSS.engine, F = VSS.fmt;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const vcolor = v => VSS.VENDORS[v].color;
  const vshort = v => VSS.VENDORS[v].short;
  const isSelf = v => !!VSS.VENDORS[v].self;

  /* ------------------------------ 상태 ------------------------------ */
  const store = {
    load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
  };
  const state = {
    req: { ...E.defaultReq(), ...store.load('vss.req', {}) },
    rfpText: store.load('vss.rfp', ''),
    extracted: null,
    result: null,
    tab: { results: 'ups', compare: 'ups' },
    selected: {},     // cat -> config id
    tp: {},           // cat -> talking points
    saved: null,      // 현재 열려 있는 저장 비교 { id, name }
    dirty: false,     // 저장 이후 변경 여부
  };
  state.req.categories = { ...E.defaultReq().categories, ...(state.req.categories || {}) };
  // 전기요금·TCO 기간은 화면에서 입력하지 않고 기본값 고정 (예전에 저장된 값이 남아 있어도 기본값 사용)
  state.req.electricityRate = E.defaultReq().electricityRate;
  state.req.years = E.defaultReq().years;
  // 고객사는 목록에서만 선택 — 목록에 없는 예전 입력값은 비움
  if (!VSS.CUSTOMERS.includes(state.req.customer)) state.req.customer = '';

  function runSelection() {
    state.result = E.run(state.req);
    state.selected = {}; state.tp = {};
    for (const [cat, r] of Object.entries(state.result.categories)) if (r.selectedId) state.selected[cat] = r.selectedId;
    const first = Object.keys(state.result.categories)[0];
    if (first) { state.tab.results = first; state.tab.compare = first; }
    state.dirty = true;
    store.save('vss.req', state.req);
  }

  /* ---------------------- 저장된 비교: 스냅샷 ---------------------- */
  // 결과를 그대로 저장해 두어, 나중에 제품 DB가 바뀌어도 저장 당시 비교를 다시 볼 수 있게 함
  function snapshot() {
    const result = JSON.parse(JSON.stringify(state.result, (k, v) => (k === 'defs' ? undefined : v)));
    const summary = {
      itLoadKW: state.req.itLoadKW, redundancy: state.req.redundancy, priority: state.req.priority,
      categories: Object.fromEntries(Object.keys(state.result.categories).map(cat => {
        const c = selectedCfg(cat);
        return [cat, c ? { product: c.product.name, desc: c.desc, score: c.score } : null];
      })),
    };
    return {
      customer: state.req.customer, site: state.req.site, summary,
      data: { version: 1, req: state.req, result, selected: state.selected, tp: state.tp, rfpText: state.rfpText },
    };
  }
  function restore(rec) {
    const d = rec.data;
    // DB(jsonb)는 객체 키 순서를 보존하지 않으므로 제품군 순서를 표준 순서로 복원
    const cats = d.result.categories;
    d.result.categories = Object.fromEntries(Object.keys(VSS.CATEGORIES).filter(c => cats[c]).map(c => [c, cats[c]]));
    for (const [cat, r] of Object.entries(d.result.categories)) r.defs = E.METRICS[cat];
    state.result = d.result;
    state.req = { ...E.defaultReq(), ...d.req };
    state.selected = d.selected || {};
    state.tp = d.tp || {};
    state.rfpText = d.rfpText || '';
    state.extracted = null;
    const first = Object.keys(d.result.categories)[0];
    if (first) { state.tab.results = first; state.tab.compare = first; }
    state.saved = { id: rec.id, name: rec.name };
    state.dirty = false;
    store.save('vss.req', state.req);
  }
  const defaultName = () => [state.req.customer, state.req.site].filter(Boolean).join(' ') +
    (state.req.customer || state.req.site ? ' · ' : '') + `IT ${state.req.itLoadKW}kW ${state.req.redundancy} (${new Date().toLocaleDateString('ko-KR')})`;

  function saveBar() {
    const s = state.saved;
    return `<div class="card no-print savebar">
      <div class="row">
        ${s ? `<span class="tag accent">저장됨</span><b>${esc(s.name)}</b>` : '<span class="tag">저장 안 됨</span><span class="muted small one-line savebar-hint">저장하면 "저장된 비교"에서 다시 열 수 있습니다.</span>'}
        ${s && state.dirty ? '<span class="tag warn">변경사항 있음</span>' : ''}
        <span class="spacer"></span>
        <input id="saveName" style="width:280px" value="${esc(s ? s.name : defaultName())}" aria-label="저장 이름">
        ${s ? `<button class="btn" id="saveUpdate" ${state.dirty ? '' : 'disabled'}>덮어쓰기</button>` : ''}
        <button class="btn primary" id="saveNew">${s ? '새로 저장' : '저장'}</button>
      </div><div id="saveMsg"></div></div>`;
  }
  function bindSaveBar() {
    const msg = (t, warn) => { $('#saveMsg').innerHTML = `<div class="notice ${warn ? 'warn' : ''}" style="margin-top:10px">${esc(t)}</div>`; };
    const doSave = async (update) => {
      const name = $('#saveName').value.trim();
      if (!name) return msg('저장 이름을 입력하세요.', true);
      if (update && !confirm(`"${state.saved.name}" 저장본을 현재 결과로 덮어쓸까요?`)) return;
      try {
        const rec = { name, ...snapshot() };
        const out = update ? await VSS.storage.update(state.saved.id, rec) : await VSS.storage.create(rec);
        state.saved = { id: out.id, name: out.name }; state.dirty = false;
        rerender();
        msg(update ? '저장된 비교를 덮어썼습니다.' : `"${out.name}" 으로 저장했습니다.`);
      } catch (e) { msg('저장 실패: ' + e.message, true); }
    };
    if ($('#saveUpdate')) $('#saveUpdate').onclick = () => doSave(true);
    $('#saveNew').onclick = () => doSave(false);
  }
  const selectedCfg = cat => {
    const r = state.result && state.result.categories[cat];
    return r && r.candidates.find(c => c.id === state.selected[cat]);
  };
  const competitorsOf = cat => {
    const r = state.result.categories[cat];
    return Object.values(r.byVendor).filter(c => !isSelf(c.product.vendor));
  };

  /* ------------------------------ 라우팅 ------------------------------ */
  const VIEWS = { '': viewHome, input: viewInput, results: viewResults, compare: viewCompare, report: viewReport, saved: viewSaved, db: viewDB, settings: viewSettings };
  function route() {
    const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || '';
    const view = VIEWS[name] || viewHome;
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#/' + name));
    $('#app').innerHTML = view();
    (view.after || (() => { }))();
    VSS.mountLogos($('#app'));
    addOverflowTitles();
    window.scrollTo(0, 0);
  }
  function rerender() { const y = window.scrollY; route(); window.scrollTo(0, y); }
  // 한 줄로 잘린(…) 문구에는 마우스를 올리면 전체 문구가 보이도록 title 지정
  function addOverflowTitles() {
    requestAnimationFrame(() => {
      document.querySelectorAll('#app td, #app .one-line, #app .ellipsis, #app .kv dd').forEach(el => {
        if (!el.title && el.scrollWidth > el.clientWidth + 1) el.title = el.textContent.trim().replace(/\s+/g, ' ');
      });
    });
  }
  window.addEventListener('resize', () => { clearTimeout(addOverflowTitles.t); addOverflowTitles.t = setTimeout(addOverflowTitles, 200); });
  function go(h) { if (location.hash === h) route(); else location.hash = h; }
  function updateBadge() {
    // AI를 쓰지 않는 기본 운영에서는 배지를 숨기고, AI 연결 시에만 표시
    const b = $('#aiBadge'), on = VSS.settings.aiEnabled();
    b.hidden = !on;
    b.className = 'ai-badge on';
    b.textContent = 'AI · ' + VSS.settings.get().model;
  }

  function needResult() {
    return `<div class="card empty"><h3>아직 선정 결과가 없습니다</h3>
      <p>요구사항을 입력하고 제품 선정을 실행하세요.</p><a class="btn primary" href="#/input">요구사항 입력하기</a></div>`;
  }
  function catTabs(key, cats) {
    return `<div class="tabs">${cats.map(c => `<button class="tab ${state.tab[key] === c ? 'active' : ''}" data-tab="${key}" data-cat="${c}">${VSS.CATEGORIES[c].icon} ${VSS.CATEGORIES[c].label}</button>`).join('')}</div>`;
  }
  function bindTabs() {
    document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { state.tab[b.dataset.tab] = b.dataset.cat; rerender(); });
  }

  /* ------------------------------ 홈 ------------------------------ */
  function viewHome() {
    return `
    <div class="card hero hero-photo">
      <div class="hero-content">
        <div class="hero-brands"><span data-logo="unipoint"></span><span class="x">×</span><span data-logo="vertiv"></span></div>
        <h1>제품 선정은 빠르게,<br>경쟁력은 명확하게</h1>
        <p class="hero-desc">고객 요구사항에 적합한 Vertiv 제품을 선정하고, 경쟁사 제품과의 객관적인 비교 분석을 통해 기술적 강점과 영업 차별화 요소를 제시합니다.</p>
        <div class="row"><a class="btn primary" href="#/input">요구사항 입력 시작</a><a class="btn glass" href="#/saved">저장된 비교</a><a class="btn glass" href="#/db">제품 리스트</a></div>
      </div>
    </div>
    <div class="grid g4" style="margin-top:16px">
      ${[['요구사항 분석', 'RFP 텍스트에서 핵심 사양 자동 추출'], ['제품 선정', '용량·이중화·부하율 기준 자동 구성 및 점수화'],
        ['경쟁사 비교', '사양·효율·TCO·기능을 표와 차트로 비교'], ['강점 도출', '차별화 포인트·반론 대응·제안 요약 생성']]
        .map((s, i) => `<div class="card step"><span class="step-n">${i + 1}</span><div style="min-width:0"><h4 class="one-line">${s[0]}</h4><div class="muted small one-line">${s[1]}</div></div></div>`).join('')}
    </div>
    <div class="section-title"><h2>데모 시나리오</h2><span class="muted small">클릭하면 요구사항 텍스트가 채워집니다</span></div>
    <div class="grid g3">
      ${VSS.SCENARIOS.map(s => `<div class="card scenario" data-sc="${s.id}"><h3 class="one-line">${esc(s.title)}</h3><div class="muted small one-line">${esc(s.desc)}</div></div>`).join('')}
    </div>`;
  }
  viewHome.after = () => {
    document.querySelectorAll('[data-sc]').forEach(el => el.onclick = () => {
      const sc = VSS.SCENARIOS.find(s => s.id === el.dataset.sc);
      state.rfpText = sc.rfp; state.extracted = null; state.saved = null; store.save('vss.rfp', sc.rfp);
      if (sc.customer) { state.req.customer = sc.customer; store.save('vss.req', state.req); }
      go('#/input');
    });
  };

  /* ---------------------------- 요구사항 ---------------------------- */
  const opt = (val, list) => list.map(([v, l]) => `<option value="${v}" ${String(val) === String(v) ? 'selected' : ''}>${l}</option>`).join('');
  function field(label, key, type = 'number', extra = '') {
    const v = state.req[key];
    return `<label class="f">${label}<input type="${type}" data-k="${key}" value="${v == null ? '' : esc(v)}" ${extra}></label>`;
  }
  function sel(label, key, list) {
    return `<label class="f">${label}<select data-k="${key}">${opt(state.req[key], list)}</select></label>`;
  }

  function viewInput() {
    const r = state.req, d = E.derived(r), ex = state.extracted;
    return `
    <div class="grid g2">
      <div class="card">
        <div class="row"><h2 style="margin:0">① 요구사항 텍스트 분석</h2><span class="spacer"></span>
          <span class="tag ${VSS.settings.aiEnabled() ? 'good' : ''}">${VSS.settings.aiEnabled() ? 'Claude AI' : '데모(규칙 기반)'}</span></div>
        <p class="muted small">RFP, 고객 이메일, 회의록을 붙여넣으면 아래 입력 폼이 자동으로 채워집니다.</p>
        <textarea id="rfp" placeholder="예) IT 부하 200kW, UPS N+1, 백업 15분, 랙 40개, 룸형 DX 냉방, 에너지 효율 중시...">${esc(state.rfpText)}</textarea>
        <div class="row" style="margin-top:10px">
          ${VSS.SCENARIOS.map(s => `<button class="btn sm" data-sc="${s.id}">${esc(s.title)}</button>`).join('')}
          <span class="spacer"></span>
          <button class="btn primary" id="analyze">요구사항 분석</button>
        </div>
        <div id="anaMsg" style="margin-top:12px">${ex ? extractedHtml(ex) : ''}</div>
      </div>

      <div class="card">
        <h2>② 공통 조건</h2>
        <div class="grid g2">
          ${sel('고객사', 'customer', [['', '고객사 선택'], ...VSS.CUSTOMERS.map(c => [c, c])])}${field('현장/프로젝트', 'site', 'text')}
          ${sel('선정 우선순위', 'priority', Object.entries(E.PRIORITY_LABELS))}
          ${field('증설 여유 (%)', 'growthPct')}
        </div>
        <div style="margin-top:14px"><div class="f" style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">대상 제품군</div>
          ${Object.entries(VSS.CATEGORIES).map(([k, c]) => `<label class="check"><input type="checkbox" data-cat-check="${k}" ${r.categories[k] ? 'checked' : ''}> ${c.label}</label>`).join('')}
        </div>
        <label class="f" style="margin-top:12px">기타 요구사항 메모<textarea data-k="notes" style="min-height:60px">${esc(r.notes)}</textarea></label>
      </div>
    </div>

    <div class="grid g3" style="margin-top:16px">
      <fieldset class="card"><legend>⚡ UPS</legend><div class="grid g2">
        ${field('IT 부하 (kW)', 'itLoadKW')}
        ${sel('이중화', 'redundancy', [['N', 'N (단일)'], ['N+1', 'N+1'], ['2N', '2N (이중 계통)']])}
        ${sel('출력 상', 'upsPhase', [[3, '3상'], [1, '단상']])}
        ${field('백업 시간 (분)', 'runtimeMin')}
        ${sel('배터리', 'batteryType', [['any', '무관'], ['VRLA', 'VRLA(납축)'], ['Li-ion', '리튬이온']])}
        ${field('최대 부하율 (%)', 'maxLoadingPct')}
      </div></fieldset>
      <fieldset class="card"><legend>❄ 정밀공조</legend><div class="grid g2">
        ${field('열부하 (kW)', 'heatLoadKW', 'number', `placeholder="자동 ${F.num(d.heatKW, 0)}" title="비워 두면 IT 부하로 자동 계산"`)}
        ${sel('설치 방식', 'coolingLayout', [['any', '무관'], ['room', '룸형'], ['inrow', '인로우']])}
        ${sel('냉각 방식', 'coolingMedium', [['any', '무관'], ['DX', 'DX(직팽)'], ['CW', '냉수(CW)']])}
        ${sel('이중화', 'coolingRedundancy', [['N', 'N'], ['N+1', 'N+1'], ['2N', '2N']])}
      </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" data-k="economizer" ${r.economizer ? 'checked' : ''}> 이코노마이저/프리쿨링 적용 검토</label>
      </fieldset>
      <fieldset class="card"><legend>▦ 랙 · PDU</legend><div class="grid g2">
        ${field('랙 수량', 'rackCount')}
        ${field('랙당 부하 (kW)', 'rackKW', 'number', `placeholder="자동 ${F.num(d.rackKW, 1)}" title="비워 두면 IT 부하 ÷ 랙 수로 자동 계산"`)}
        ${sel('랙 높이', 'rackHeightU', [[42, '42U'], [47, '47U'], [48, '48U']])}
        ${sel('랙 폭', 'rackWidth', [[600, '600mm'], [750, '750mm'], [800, '800mm']])}
        ${sel('랙 깊이', 'rackDepth', [[1000, '1000mm'], [1100, '1100mm'], [1200, '1200mm']])}
        ${sel('PDU 상', 'pduPhase', [[1, '단상'], [3, '3상']])}
        ${sel('PDU 등급', 'pduLevel', Object.entries(E.PDU_LEVEL_LABEL))}
      </div></fieldset>
    </div>

    <div class="row" style="margin-top:18px">
      <span class="muted small">설계 열부하 ${F.num(d.heatKW, 0)}kW · 랙당 설계부하 ${F.num(d.rackKW, 1)}kW (증설 여유 포함)</span>
      <span class="spacer"></span>
      <button class="btn" id="reset">초기화</button>
      <button class="btn primary" id="run">Vertiv 제품 선정 실행 →</button>
    </div>`;
  }

  function extractedHtml(ex) {
    return `<div class="notice"><b>${ex.source === 'ai' ? 'AI' : '규칙 기반'} 분석 결과</b> — 아래 폼에 반영되었습니다. 확인 후 수정하세요.<br>
      ${ex.summary.length ? ex.summary.map(s => `<span class="tag accent">${esc(s)}</span>`).join('') : '<span class="muted">추출된 항목이 없습니다.</span>'}</div>`;
  }

  function readNum(v) { return v === '' ? null : Number(v); }
  viewInput.after = () => {
    const numKeys = new Set(['itLoadKW', 'growthPct', 'runtimeMin', 'maxLoadingPct', 'heatLoadKW', 'rackCount', 'rackKW', 'electricityRate', 'years', 'upsPhase', 'pduPhase', 'rackHeightU', 'rackWidth', 'rackDepth']);
    document.querySelectorAll('[data-k]').forEach(el => {
      el.onchange = () => {
        const k = el.dataset.k;
        state.req[k] = el.type === 'checkbox' ? el.checked : numKeys.has(k) ? readNum(el.value) : el.value;
        store.save('vss.req', state.req);
        if (['itLoadKW', 'growthPct', 'rackCount'].includes(k)) rerender();
      };
    });
    document.querySelectorAll('[data-cat-check]').forEach(el => el.onchange = () => { state.req.categories[el.dataset.catCheck] = el.checked; store.save('vss.req', state.req); });
    document.querySelectorAll('[data-sc]').forEach(el => el.onclick = () => {
      const sc = VSS.SCENARIOS.find(s => s.id === el.dataset.sc);
      $('#rfp').value = sc.rfp; state.rfpText = sc.rfp; state.saved = null; store.save('vss.rfp', sc.rfp);
      if (sc.customer) { state.req.customer = sc.customer; store.save('vss.req', state.req); rerender(); }
    });
    $('#rfp').oninput = e => { state.rfpText = e.target.value; store.save('vss.rfp', state.rfpText); };
    $('#analyze').onclick = async () => {
      const text = $('#rfp').value.trim();
      if (!text) { $('#anaMsg').innerHTML = '<div class="notice warn">분석할 텍스트를 입력하세요.</div>'; return; }
      const btn = $('#analyze'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 분석 중...';
      try {
        const ex = await VSS.ai.parseRequirements(text);
        applyExtracted(ex.fields);
        state.extracted = ex;
        rerender();
      } catch (err) {
        const ex = VSS.ai.demoParse(text);
        applyExtracted(ex.fields); state.extracted = ex; rerender();
        $('#anaMsg').insertAdjacentHTML('afterbegin', `<div class="notice warn" style="margin-bottom:8px">${esc(err.message)} → 규칙 기반 분석으로 대체했습니다.</div>`);
      }
    };
    $('#reset').onclick = () => { state.req = E.defaultReq(); state.extracted = null; state.saved = null; store.save('vss.req', state.req); rerender(); };
    $('#run').onclick = () => {
      if (!(state.req.itLoadKW > 0)) { alert('IT 부하(kW)를 입력하세요.'); return; }
      runSelection(); go('#/results');
    };
  };

  function applyExtracted(f) {
    const r = state.req;
    for (const [k, v] of Object.entries(f)) {
      if (v == null || k === 'summary') continue;
      if (k === 'monitoring') { r.categories.monitoring = !!v; continue; }
      if (k === 'customer') { if (VSS.CUSTOMERS.includes(v)) r.customer = v; continue; } // 목록에 있는 고객사만
      if (k === 'electricityRate' || k === 'years') continue;
      if (k in r) r[k] = v;
    }
    // 텍스트로 새 분석 시 이전 수동 자동계산값 초기화
    if (f.heatLoadKW == null) r.heatLoadKW = null;
    if (f.rackKW == null) r.rackKW = null;
    store.save('vss.req', r);
  }

  /* ---------------------------- 추천 결과 ---------------------------- */
  function viewResults() {
    if (!state.result) return needResult();
    const cats = Object.keys(state.result.categories);
    const cat = state.tab.results, R = state.result.categories[cat], req = state.result.req, d = state.result.derived;
    let body;
    if (R.empty || !R.vertiv.length) {
      body = `<div class="card empty">조건을 만족하는 ${R.empty ? '' : 'Vertiv '}제품이 샘플 DB에 없습니다. 요구사항(상, 방식, 규격 등)을 조정해 보세요.</div>`;
    } else {
      const sel = selectedCfg(cat) || R.vertiv[0];
      const rank = R.candidates.indexOf(sel) + 1;
      body = `
      <div class="grid g2">
        <div class="card reco">
          <div class="row"><span class="tag accent">Vertiv 추천</span><span class="tag">전체 ${R.candidates.length}개 후보 중 ${rank}위</span></div>
          <div class="row" style="margin:10px 0 4px;align-items:flex-end">
            <div><h2 style="margin:0">${esc(sel.product.name)}</h2><div class="muted">${esc(sel.product.desc)}</div></div>
            <span class="spacer"></span><div class="score num">${sel.score}<small> /100</small></div>
          </div>
          <div class="notice" style="margin:12px 0"><b>추천 구성</b> · ${esc(sel.desc)}</div>
          <dl class="kv">
            ${R.defs.map(def => `<dt>${def.label}${def.key === 'tco' ? ` (${req.years}년)` : ''}</dt><dd class="num">${def.fmt(sel.metrics[def.key])}</dd>`).join('')}
            ${sel.info.map(([k, v]) => `<dt>${k}</dt><dd class="num">${v}</dd>`).join('')}
          </dl>
          ${sel.reasons.length ? `<h4 style="margin-top:14px">추천 근거</h4><ul class="list good">${sel.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn primary" data-goto-compare="${cat}">경쟁사와 비교 →</button></div>
        </div>
        <div>
          <div class="card">
            <h3>Vertiv 대안 구성</h3>
            ${R.vertiv.map(c => `
              <div class="card alt ${c.id === sel.id ? 'selected' : ''}" data-pick="${c.id}" style="margin-top:10px;padding:12px">
                <div class="row"><b>${esc(c.product.name)}</b><span class="spacer"></span><span class="num"><b>${c.score}</b>점</span></div>
                <div class="muted small one-line">${esc(c.desc)} · ${F.won(c.metrics.capex)}</div>
                <div class="bar" style="margin-top:6px"><i style="width:${c.score}%"></i></div>
              </div>`).join('')}
          </div>
          <div class="card">
            <h3>선정 기준</h3>
            <dl class="kv small">
              <dt>우선순위</dt><dd>${E.PRIORITY_LABELS[req.priority]}</dd>
              <dt>부하 / 이중화</dt><dd>IT ${req.itLoadKW}kW · UPS ${req.redundancy} · 증설 ${req.growthPct}%</dd>
              <dt>설계값</dt><dd>열부하 ${F.num(d.heatKW, 0)}kW · 랙당 ${F.num(d.rackKW, 1)}kW</dd>
              <dt>TCO 기준</dt><dd>${req.years}년 · ${req.electricityRate}원/kWh</dd>
            </dl>
          </div>
        </div>
      </div>
      <div class="section-title"><h2>전체 후보 순위</h2><span class="muted small">요구사항을 충족하는 모든 제조사 구성 (점수 = 우선순위 가중 평균)</span></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>#</th><th>제조사</th><th>제품</th><th>구성</th>${R.defs.map(df => `<th class="r">${df.label}</th>`).join('')}<th class="r">종합점수</th></tr></thead>
        <tbody>${R.candidates.map((c, i) => `
          <tr class="${isSelf(c.product.vendor) ? 'self' : ''}">
            <td>${i + 1}</td><td><span class="vendor-dot" style="background:${vcolor(c.product.vendor)}"></span>${vshort(c.product.vendor)}</td>
            <td>${esc(c.product.name)}</td><td class="small">${esc(c.desc)}</td>
            ${R.defs.map(df => `<td class="r num">${df.fmt(c.metrics[df.key])}</td>`).join('')}
            <td class="r num"><b>${c.score}</b></td></tr>`).join('')}
        </tbody></table></div>`;
    }
    return `<div class="row"><h1 style="margin:0">추천 결과</h1><span class="spacer"></span>
      <span class="muted small">${esc(req.customer || '')} ${esc(req.site || '')}</span></div><div style="height:14px"></div>
      ${saveBar()}${catTabs('results', cats)}${body}`;
  }
  viewResults.after = () => {
    bindTabs(); bindSaveBar();
    document.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      if (state.selected[state.tab.results] === el.dataset.pick) return;
      state.selected[state.tab.results] = el.dataset.pick; delete state.tp[state.tab.results]; state.dirty = true; rerender();
    });
    document.querySelectorAll('[data-goto-compare]').forEach(el => el.onclick = () => { state.tab.compare = el.dataset.gotoCompare; go('#/compare'); });
  };

  /* ---------------------------- 경쟁사 비교 ---------------------------- */
  function radarSvg(defs, series) {
    const W = 420, H = 340, cx = W / 2, cy = H / 2 + 6, R = 120, n = defs.length;
    const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
    let g = '';
    for (const lv of [25, 50, 75, 100]) g += `<polygon points="${defs.map((_, i) => pt(i, lv).join(',')).join(' ')}" fill="none" stroke="var(--border)"/>`;
    defs.forEach((df, i) => {
      const [x, y] = pt(i, 100), [lx, ly] = pt(i, 122);
      g += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)"/>`;
      g += `<text x="${lx}" y="${ly}" font-size="11.5" fill="var(--muted)" text-anchor="${Math.abs(lx - cx) < 10 ? 'middle' : lx > cx ? 'start' : 'end'}" dominant-baseline="middle">${esc(df.label.replace(/\(.*\)/, ''))}</text>`;
    });
    // 경쟁사 먼저, Vertiv 마지막(위에)
    [...series].reverse().forEach(s => {
      const pts = defs.map((df, i) => pt(i, s.cfg.scores[df.key]).join(',')).join(' ');
      const self = isSelf(s.cfg.product.vendor);
      g += `<polygon points="${pts}" fill="${s.color}" fill-opacity="${self ? .18 : .05}" stroke="${s.color}" stroke-width="${self ? 2.5 : 1.5}" ${self ? '' : 'stroke-dasharray="4 3"'}/>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="지표별 상대 점수 레이더 차트">${g}</svg>`;
  }

  function barSvg(items, label) {
    const max = Math.max(...items.map(i => i.value)), W = 420, rowH = 34, H = items.length * rowH + 10, lw = 90;
    let g = '';
    items.forEach((it, i) => {
      const y = i * rowH + 6, w = (W - lw - 90) * it.value / max;
      g += `<text x="0" y="${y + 13}" font-size="12" fill="var(--text)">${esc(it.name)}</text>
        <rect x="${lw}" y="${y + 2}" width="${Math.max(w, 2)}" height="18" rx="3" fill="${it.color}" fill-opacity="${it.self ? 1 : .55}"/>
        <text x="${lw + w + 6}" y="${y + 15}" font-size="12" fill="var(--muted)" class="num">${esc(it.text)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${g}</svg>`;
  }

  function tpHtml(tp) {
    return `<div class="tp-head">${esc(tp.headline)}</div>
      <div class="grid g2" style="margin-top:12px">
        <div><h4>핵심 메시지</h4><ul class="list good">${tp.keyMessages.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>
        <div><h4>예상 반론 대응</h4>${tp.objectionHandling.length ? tp.objectionHandling.map(o => `<div style="margin-bottom:8px"><div><b>Q.</b> ${esc(o.objection)}</div><div class="muted"><b>A.</b> ${esc(o.response)}</div></div>`).join('') : '<div class="muted small">주요 열세 항목이 없습니다.</div>'}</div>
      </div>
      <h4 style="margin-top:10px">제안 요약</h4><p style="margin:0">${esc(tp.proposalSummary)}</p>
      <div class="muted small" style="margin-top:8px">생성: ${tp.source === 'ai' ? 'Claude AI' : '규칙 기반(데모)'}</div>`;
  }

  function viewCompare() {
    if (!state.result) return needResult();
    const cats = Object.keys(state.result.categories).filter(c => !state.result.categories[c].empty);
    if (!cats.includes(state.tab.compare)) state.tab.compare = cats[0];
    const cat = state.tab.compare, R = state.result.categories[cat], req = state.result.req;
    const v = selectedCfg(cat);
    if (!v) return `${catTabs('compare', cats)}<div class="card empty">이 제품군은 Vertiv 추천 구성이 없습니다.</div>`;
    const comps = competitorsOf(cat).map(c => ({ cfg: c, cmp: E.compare(v, c, R.defs, req) }));
    const series = [{ cfg: v, color: vcolor(v.product.vendor) }, ...comps.map(x => ({ cfg: x.cfg, color: vcolor(x.cfg.product.vendor) }))];
    const costKey = R.defs.some(d => d.key === 'tco') ? 'tco' : 'capex';
    const bars = series.map(s => ({ name: vshort(s.cfg.product.vendor), value: s.cfg.metrics[costKey], text: F.won(s.cfg.metrics[costKey]), color: s.color, self: isSelf(s.cfg.product.vendor) }));

    const bestOf = df => {
      const vals = series.map(s => s.cfg.metrics[df.key]);
      return df.better === 'high' ? Math.max(...vals) : Math.min(...vals);
    };
    const tp = state.tp[cat];
    return `
    <div class="row"><h1 style="margin:0">경쟁사 비교</h1><span class="spacer"></span><a class="btn sm" href="#/results">← 추천 구성 변경</a></div>
    <div style="height:14px"></div>
    ${saveBar()}
    ${catTabs('compare', cats)}
    ${comps.length ? '' : '<div class="notice warn">요구사항을 충족하는 경쟁사 제품이 샘플 DB에 없습니다.</div>'}
    <div class="grid g2">
      <div class="card chart"><h3>지표별 상대 점수</h3><div class="muted small">각 지표에서 가장 우수한 제품 = 100</div>
        ${radarSvg(R.defs, series)}
        <div class="legend">${series.map(s => `<span><span class="vendor-dot" style="background:${s.color}"></span>${esc(s.cfg.product.name)}</span>`).join('')}</div>
      </div>
      <div class="card chart"><h3>${costKey === 'tco' ? `${req.years}년 TCO 비교` : '초기 투자비 비교'}</h3>
        <div class="muted small">${costKey === 'tco' ? '초기 투자비 + 전력비 + 유지보수비(연 3%)' : '가상 가격 기준'}</div>
        <div style="margin-top:14px">${barSvg(bars, 'TCO 비교 막대 차트')}</div>
        <div class="grid g2" style="margin-top:14px">
          ${comps.map(x => `<div class="small"><span class="vendor-dot" style="background:${vcolor(x.cfg.product.vendor)}"></span>vs ${vshort(x.cfg.product.vendor)}: <b class="num">${x.cmp.wins}승 ${x.cmp.losses}패</b></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="section-title"><h2>사양 · 성능 · 가격 비교표</h2></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>항목</th>${series.map(s => `<th class="r" style="${isSelf(s.cfg.product.vendor) ? 'color:var(--accent)' : ''}"><span class="vendor-dot" style="background:${s.color}"></span>${vshort(s.cfg.product.vendor)}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><td>제품</td>${series.map(s => `<td class="r"><b>${esc(s.cfg.product.name)}</b></td>`).join('')}</tr>
        <tr><td>구성</td>${series.map(s => `<td class="r small">${esc(s.cfg.desc)}</td>`).join('')}</tr>
        ${R.defs.map(df => { const b = bestOf(df); return `<tr><td>${df.label}</td>${series.map(s => `<td class="r num ${s.cfg.metrics[df.key] === b ? 'win' : ''}">${df.fmt(s.cfg.metrics[df.key])}</td>`).join('')}</tr>`; }).join('')}
        <tr><td>종합점수</td>${series.map(s => `<td class="r num"><b>${s.cfg.score}</b></td>`).join('')}</tr>
        ${Object.keys(VSS.FEATURES).filter(f => series.some(s => s.cfg.product.features.includes(f))).map(f =>
          `<tr><td class="small">${VSS.FEATURES[f]}</td>${series.map(s => `<td class="r">${s.cfg.product.features.includes(f) ? '<span style="color:var(--good)">●</span>' : '<span class="muted">–</span>'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>

    <div class="section-title"><h2>경쟁사별 강점 · 약점</h2><span class="muted small">Vertiv ${esc(v.product.name)} 기준</span></div>
    <div class="grid g2">
      ${comps.map(x => `
        <div class="card">
          <div class="row"><h3 style="margin:0"><span class="vendor-dot" style="background:${vcolor(x.cfg.product.vendor)}"></span>vs ${esc(x.cfg.product.name)}</h3><span class="spacer"></span><span class="tag">${esc(x.cfg.desc)}</span></div>
          <h4 style="margin-top:12px;color:var(--good)">강점 (${x.cmp.strengths.length})</h4>
          ${x.cmp.strengths.length ? `<ul class="list good">${x.cmp.strengths.map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>` : '<div class="muted small">두드러진 강점 없음</div>'}
          <h4 style="margin-top:10px;color:var(--warn)">약점 · 대응 (${x.cmp.weaknesses.length})</h4>
          ${x.cmp.weaknesses.length ? `<ul class="list warn">${x.cmp.weaknesses.map(w => `<li>${esc(w.text)}${w.rebuttal ? `<div class="rebuttal">↳ ${esc(w.rebuttal)}</div>` : ''}</li>`).join('')}</ul>` : '<div class="muted small">열세 항목 없음</div>'}
        </div>`).join('')}
    </div>

    <div class="section-title"><h2>영업 메시지</h2><span class="spacer"></span>
      <button class="btn primary" id="genTp">${tp ? '다시 생성' : (VSS.settings.aiEnabled() ? 'AI로 영업 메시지 생성' : '영업 메시지 생성(데모)')}</button></div>
    <div class="card" id="tpBox">${tp ? tpHtml(tp) : '<div class="muted">버튼을 눌러 차별화 메시지, 반론 대응, 제안 요약을 생성하세요.</div>'}</div>`;
  }
  viewCompare.after = () => {
    bindTabs();
    if ($('#saveNew')) bindSaveBar();
    const btn = $('#genTp'); if (!btn) return;
    btn.onclick = async () => {
      const cat = state.tab.compare, R = state.result.categories[cat], v = selectedCfg(cat);
      const comps = competitorsOf(cat).map(c => ({ cfg: c, cmp: E.compare(v, c, R.defs, state.result.req) }));
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 생성 중...';
      try {
        state.tp[cat] = await VSS.ai.talkingPoints(cat, v, comps, state.result.req);
        state.dirty = true;
        rerender();
      } catch (err) {
        state.tp[cat] = E.demoTalkingPoints(cat, v, comps, state.result.req);
        state.dirty = true;
        rerender();
        $('#tpBox').insertAdjacentHTML('afterbegin', `<div class="notice warn" style="margin-bottom:10px">${esc(err.message)} → 규칙 기반 메시지로 대체했습니다.</div>`);
      }
    };
  };

  /* ---------------------------- 제안 리포트 ---------------------------- */
  function viewReport() {
    if (!state.result) return needResult();
    const req = state.result.req, d = state.result.derived;
    const sections = Object.entries(state.result.categories).map(([cat, R]) => {
      const v = selectedCfg(cat);
      if (!v) return `<h2>${VSS.CATEGORIES[cat].label}</h2><p class="muted">조건을 충족하는 Vertiv 제품 없음</p>`;
      const comps = competitorsOf(cat).map(c => ({ cfg: c, cmp: E.compare(v, c, R.defs, req) }));
      const tp = state.tp[cat] || E.demoTalkingPoints(cat, v, comps, req);
      return `
        <h2>${VSS.CATEGORIES[cat].icon} ${VSS.CATEGORIES[cat].label} — ${esc(v.product.name)}</h2>
        <div class="grid g2">
          <div><dl class="kv"><dt>추천 구성</dt><dd>${esc(v.desc)}</dd>
            ${R.defs.map(df => `<dt>${df.label}</dt><dd class="num">${df.fmt(v.metrics[df.key])}</dd>`).join('')}</dl></div>
          <div><h4>핵심 메시지</h4><ul class="list good">${tp.keyMessages.slice(0, 5).map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>
        </div>
        ${comps.length ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>비교 대상</th><th>구성</th>${R.defs.map(df => `<th class="r">${df.label}</th>`).join('')}<th class="r">승/패</th></tr></thead><tbody>
          <tr class="self"><td><b>${esc(v.product.name)}</b></td><td class="small">${esc(v.desc)}</td>${R.defs.map(df => `<td class="r num">${df.fmt(v.metrics[df.key])}</td>`).join('')}<td></td></tr>
          ${comps.map(x => `<tr><td>${esc(x.cfg.product.name)}</td><td class="small">${esc(x.cfg.desc)}</td>${R.defs.map(df => `<td class="r num">${df.fmt(x.cfg.metrics[df.key])}</td>`).join('')}<td class="r num">${x.cmp.wins}/${x.cmp.losses}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
        ${tp.objectionHandling.length ? `<h4 style="margin-top:12px">반론 대응</h4>${tp.objectionHandling.map(o => `<div class="small"><b>Q.</b> ${esc(o.objection)} — <span class="muted">${esc(o.response)}</span></div>`).join('')}` : ''}`;
    }).join('');
    return `
    <div class="row no-print"><h1 style="margin:0">제안 리포트</h1><span class="spacer"></span>
      <span class="muted small">영업 메시지를 생성하지 않은 제품군은 규칙 기반 요약이 들어갑니다</span>
      <button class="btn primary" onclick="window.print()">PDF로 저장 / 인쇄</button></div>
    <div style="height:14px" class="no-print"></div>${saveBar()}
    <div class="card report" style="margin-top:14px">
      <div class="report-head">
        <span class="report-logo" data-logo="unipoint"></span>
        <span class="spacer"></span>
        <span class="report-logo partner" data-logo="vertiv"></span>
      </div>
      <div class="row" style="margin-top:18px"><div><div class="muted small">Vertiv 솔루션 제안 요약</div><h1 style="margin:4px 0">${esc(req.customer || '고객사')} ${esc(req.site || '')}</h1></div>
        <span class="spacer"></span><div class="muted small" style="text-align:right">${new Date().toLocaleDateString('ko-KR')}<br>작성: ${esc(VSS.BRAND.company)}</div></div>
      <h2>고객 요구사항</h2>
      <dl class="kv">
        <dt>IT 부하</dt><dd>${req.itLoadKW} kW (증설 여유 ${req.growthPct}%)</dd>
        <dt>전력 이중화</dt><dd>${req.redundancy} · ${req.upsPhase}상 · 백업 ${req.runtimeMin}분 · 배터리 ${req.batteryType === 'any' ? '무관' : req.batteryType}</dd>
        <dt>냉방</dt><dd>설계 열부하 ${F.num(d.heatKW, 0)} kW · ${req.coolingRedundancy} · ${{ any: '방식 무관', room: '룸형', inrow: '인로우' }[req.coolingLayout]} / ${req.coolingMedium === 'any' ? 'DX·CW 무관' : req.coolingMedium}</dd>
        <dt>랙 / PDU</dt><dd>${req.rackCount}개 · 랙당 ${F.num(d.rackKW, 1)} kW · ${req.rackHeightU}U ${req.rackWidth}mm · ${E.PDU_LEVEL_LABEL[req.pduLevel]}</dd>
        <dt>선정 우선순위</dt><dd>${E.PRIORITY_LABELS[req.priority]}</dd>
        ${req.notes ? `<dt>기타</dt><dd>${esc(req.notes)}</dd>` : ''}
      </dl>
      ${sections}
      <p class="muted small" style="margin-top:24px">※ 본 자료의 사양은 공개 자료 기반 근사치이며 가격은 가상값입니다. TCO = 초기 투자비 + ${req.years}년 전력비(${req.electricityRate}원/kWh) + 유지보수비(연 3%).</p>
    </div>`;
  }

  viewReport.after = () => { if ($('#saveNew')) bindSaveBar(); };

  /* ---------------------------- 저장된 비교 ---------------------------- */
  const savedView = { list: null, q: '', checked: new Set(), error: null };
  function viewSaved() {
    const sv = savedView;
    const where = VSS.storage.mode !== 'server' ? '이 브라우저에만 저장됩니다 (node server.js 로 실행하면 DB에 저장)'
      : VSS.storage.kind === 'supabase' ? 'Supabase 클라우드 DB에 저장 · 같은 서버를 쓰는 사람과 공유됩니다'
        : '서버 로컬 DB(data/vss.db)에 저장 · 같은 서버를 쓰는 사람과 공유됩니다';
    let body;
    if (sv.error) body = `<div class="notice warn">${esc(sv.error)}</div>`;
    else if (!sv.list) body = '<div class="empty"><span class="spinner"></span> 불러오는 중...</div>';
    else {
      const q = sv.q.trim().toLowerCase();
      const rows = sv.list.filter(r => !q || [r.name, r.customer, r.site].join(' ').toLowerCase().includes(q));
      const allChecked = rows.length && rows.every(r => sv.checked.has(r.id));
      body = !sv.list.length
        ? `<div class="empty"><h3>저장된 비교가 없습니다</h3><p>추천 결과·경쟁사 비교 화면 상단의 <b>저장</b> 버튼으로 저장하세요.</p><a class="btn primary" href="#/input">새 비교 시작</a></div>`
        : `<div class="table-wrap"><table>
          <thead><tr><th style="width:32px"><input type="checkbox" id="chkAll" ${allChecked ? 'checked' : ''} aria-label="전체 선택"></th>
            <th>이름</th><th>고객 / 현장</th><th>조건</th><th>Vertiv 추천 구성</th><th>수정일</th><th class="r">관리</th></tr></thead>
          <tbody>${rows.map(r => `<tr class="${state.saved && state.saved.id === r.id ? 'self' : ''}">
            <td><input type="checkbox" data-chk="${r.id}" ${sv.checked.has(r.id) ? 'checked' : ''} aria-label="선택"></td>
            <td><a href="#" data-open="${r.id}"><b>${esc(r.name)}</b></a>${state.saved && state.saved.id === r.id ? ' <span class="tag accent">열려 있음</span>' : ''}</td>
            <td>${esc(r.customer || '-')}<div class="muted small">${esc(r.site || '')}</div></td>
            <td class="small">IT ${r.summary.itLoadKW}kW · ${esc(r.summary.redundancy)}<div class="muted">${E.PRIORITY_LABELS[r.summary.priority] || ''}</div></td>
            <td class="small">${Object.keys(VSS.CATEGORIES).map(cat => { const c = r.summary.categories[cat]; return c ? `<div>${VSS.CATEGORIES[cat].icon} ${esc(c.product)} <span class="muted">(${c.score}점)</span></div>` : ''; }).join('')}</td>
            <td class="small num">${new Date(r.updatedAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td class="r" style="white-space:nowrap"><button class="btn sm" data-open="${r.id}">열기</button> <button class="btn sm" data-del="${r.id}">삭제</button></td>
          </tr>`).join('')}</tbody></table></div>
          ${rows.length ? '' : '<div class="empty">검색 결과가 없습니다.</div>'}`;
    }
    return `
    <div class="row"><h1 style="margin:0">저장된 비교</h1>${sv.list ? `<span class="tag">${sv.list.length}건</span>` : ''}<span class="spacer"></span>
      <a class="btn" href="#/input">+ 새 비교</a></div>
    <div class="muted small" style="margin:6px 0 14px">${where}</div>
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <input id="savedQ" style="max-width:320px" placeholder="이름, 고객사, 현장 검색" value="${esc(sv.q)}">
        <span class="spacer"></span>
        <button class="btn" id="delChecked" ${sv.checked.size ? '' : 'disabled'}>선택 삭제 (${sv.checked.size})</button>
      </div>
      <div id="savedMsg"></div>
      ${body}
    </div>`;
  }
  async function loadSaved() {
    try { savedView.list = await VSS.storage.list(); savedView.error = null; }
    catch (e) { savedView.error = '목록을 불러오지 못했습니다: ' + e.message; }
    const ids = new Set((savedView.list || []).map(r => r.id));
    savedView.checked = new Set([...savedView.checked].filter(id => ids.has(id)));
    if (location.hash.startsWith('#/saved')) rerenderSavedOnly();
  }
  async function deleteSaved(ids) {
    const names = savedView.list.filter(r => ids.includes(r.id)).map(r => `• ${r.name}`).join('\n');
    if (!confirm(`다음 ${ids.length}건을 삭제할까요? 삭제하면 되돌릴 수 없습니다.\n\n${names}`)) return;
    const failed = [];
    for (const id of ids) {
      try { await VSS.storage.remove(id); savedView.checked.delete(id); if (state.saved && state.saved.id === id) state.saved = null; }
      catch (e) { failed.push(id); }
    }
    await loadSaved();
    if (failed.length) $('#savedMsg').innerHTML = `<div class="notice warn" style="margin-bottom:10px">${failed.length}건 삭제에 실패했습니다.</div>`;
  }
  viewSaved.after = () => {
    if (!viewSaved.loading) { viewSaved.loading = true; loadSaved().finally(() => { viewSaved.loading = false; }); }
    const q = $('#savedQ');
    q.oninput = () => { savedView.q = q.value; const pos = q.selectionStart; rerenderSavedOnly(); const el = $('#savedQ'); el.focus(); el.setSelectionRange(pos, pos); };
    document.querySelectorAll('[data-open]').forEach(el => el.onclick = async e => {
      e.preventDefault();
      if (state.dirty && state.result && !confirm('현재 비교에 저장하지 않은 변경사항이 있습니다. 무시하고 열까요?')) return;
      try { restore(await VSS.storage.get(Number(el.dataset.open))); go('#/compare'); }
      catch (err) { $('#savedMsg').innerHTML = `<div class="notice warn" style="margin-bottom:10px">${esc(err.message)}</div>`; }
    });
    document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => deleteSaved([Number(el.dataset.del)]));
    document.querySelectorAll('[data-chk]').forEach(el => el.onchange = () => {
      const id = Number(el.dataset.chk); el.checked ? savedView.checked.add(id) : savedView.checked.delete(id); rerenderSavedOnly();
    });
    const all = $('#chkAll');
    if (all) all.onchange = () => {
      const q2 = savedView.q.trim().toLowerCase();
      savedView.list.filter(r => !q2 || [r.name, r.customer, r.site].join(' ').toLowerCase().includes(q2))
        .forEach(r => all.checked ? savedView.checked.add(r.id) : savedView.checked.delete(r.id));
      rerenderSavedOnly();
    };
    $('#delChecked').onclick = () => deleteSaved([...savedView.checked]);
  };
  // 목록을 다시 불러오지 않고 화면만 갱신
  function rerenderSavedOnly() { viewSaved.loading = true; rerender(); viewSaved.loading = false; }

  /* --------------------------- 제품 리스트 --------------------------- */
  const dbFilter = { cat: 'all', vendor: 'all', q: '' };
  function specText(p) {
    switch (p.category) {
      case 'ups': return `${p.phase}상 · ${p.modular ? `모듈 ${p.modular.moduleKW}kW, ${p.modular.minKW}~${p.modular.maxKW}kW` : p.ratingsKW.join('/') + 'kW'} · 효율 ${p.effDouble}% (ECO ${p.effEco}%) · 병렬 ${p.maxParallel}대`;
      case 'thermal': return `${p.type === 'inrow' ? '인로우' : '룸형'} ${p.medium} · ${p.ratingsKW.join('/')}kW · EER ${p.eer}${p.econSaving ? ` · 이코노마이저 ${Math.round(p.econSaving * 100)}%` : ''}`;
      case 'pdu': return `${p.ratings.map(r => r.phase + '상' + r.amps + 'A').join(', ')} · ${p.levels.map(l => E.PDU_LEVEL_LABEL[l].split('(')[0]).join('/')} · ${p.maxTempC}°C · ±${p.accuracyPct}%`;
      case 'rack': return `${p.heights.join('/')}U · 폭 ${p.widths.join('/')} · 깊이 ${p.depths.join('/')} · 정하중 ${p.staticKg}kg · 통기율 ${p.perforationPct}%`;
      case 'monitoring': return `최대 ${p.maxDevices.toLocaleString()}대`;
    }
  }
  function priceText(p) {
    if (p.pricePerKW != null) return `${p.priceBase} + ${p.pricePerKW}/kW`;
    if (p.priceUnit != null) return `${p.priceUnit}/대`;
    if (p.pricePerDevice != null) return `${p.priceBase} + ${p.pricePerDevice}/장비`;
    return `기준가 × ${p.priceFactor}`;
  }
  function viewDB() {
    const list = VSS.PRODUCTS.filter(p => (dbFilter.cat === 'all' || p.category === dbFilter.cat) && (dbFilter.vendor === 'all' || p.vendor === dbFilter.vendor) &&
      (!dbFilter.q || (p.name + p.desc + p.vendor).toLowerCase().includes(dbFilter.q.toLowerCase())));
    return `
    <div class="row"><h1 style="margin:0">제품 리스트</h1><span class="tag">${VSS.PRODUCTS.length}개 제품 · ${Object.keys(VSS.VENDORS).length}개 제조사</span></div>
    <div class="notice warn" style="margin:12px 0">샘플 데이터입니다. 사양은 공개 자료 기반 근사치, 가격은 가상값(만원)이며 <code>js/data.js</code>에서 수정할 수 있습니다.</div>
    <div class="card"><div class="grid g3">
      <label class="f">제품군<select id="fCat"><option value="all">전체</option>${Object.entries(VSS.CATEGORIES).map(([k, c]) => `<option value="${k}" ${dbFilter.cat === k ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
      <label class="f">제조사<select id="fVendor"><option value="all">전체</option>${Object.keys(VSS.VENDORS).map(v => `<option ${dbFilter.vendor === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">검색<input id="fQ" value="${esc(dbFilter.q)}" placeholder="제품명, 설명"></label>
    </div></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>제품군</th><th>제조사</th><th>제품</th><th>주요 사양</th><th>기능</th><th class="r">가상가(만원)</th></tr></thead>
      <tbody>${list.map(p => `<tr class="${isSelf(p.vendor) ? 'self' : ''}">
        <td>${VSS.CATEGORIES[p.category].label}</td>
        <td><span class="vendor-dot" style="background:${vcolor(p.vendor)}"></span>${vshort(p.vendor)}</td>
        <td><b>${esc(p.name)}</b><div class="muted small">${esc(p.desc)}</div></td>
        <td class="small cell-clip">${esc(specText(p))}</td>
        <td title="${esc(p.features.map(f => VSS.FEATURES[f]).join(', '))}">${p.features.slice(0, 2).map(f => `<span class="tag">${VSS.FEATURES[f]}</span>`).join('')}${p.features.length > 2 ? `<span class="tag accent">+${p.features.length - 2}</span>` : ''}</td>
        <td class="r small num">${priceText(p)}</td></tr>`).join('')}
      </tbody></table>${list.length ? '' : '<div class="empty">조건에 맞는 제품이 없습니다.</div>'}</div>`;
  }
  viewDB.after = () => {
    $('#fCat').onchange = e => { dbFilter.cat = e.target.value; rerender(); };
    $('#fVendor').onchange = e => { dbFilter.vendor = e.target.value; rerender(); };
    $('#fQ').oninput = e => { dbFilter.q = e.target.value; const pos = e.target.selectionStart; rerender(); const q = $('#fQ'); q.focus(); q.setSelectionRange(pos, pos); };
  };

  /* ------------------------------ 설정 ------------------------------ */
  function viewSettings() {
    const s = VSS.settings.get();
    const served = /^https?:/.test(location.protocol);
    return `
    <h1>설정</h1>
    <div class="grid g2">
      <div class="card">
        <h3>Claude AI 연결</h3>
        <div class="notice ${VSS.serverKey ? '' : 'warn'}" style="margin-bottom:12px">
          ${VSS.serverKey ? '서버(.env)에 API 키가 설정되어 있어 프록시로 안전하게 호출합니다.'
            : served ? '서버에 API 키가 없습니다. 프로젝트 폴더의 <code>.env</code>에 <code>ANTHROPIC_API_KEY=...</code>를 넣고 서버를 재시작하거나, 아래에 키를 입력하세요.'
              : '파일을 직접 열어 실행 중입니다. <code>node server.js</code>로 실행하면 API 키를 서버에 안전하게 둘 수 있습니다.'}
        </div>
        <label class="check"><input type="checkbox" id="sUse" ${s.useAI ? 'checked' : ''}> AI 기능 사용 (끄면 규칙 기반 데모 모드)</label>
        <div class="grid" style="margin-top:12px">
          ${VSS.serverKey ? '' : `<label class="f" title="이 PC의 브라우저에만 저장됩니다">브라우저용 API 키<input type="password" id="sKey" value="${esc(s.apiKey)}" placeholder="sk-ant-..."></label>`}
          <label class="f">모델<select id="sModel">${opt(s.model, [['claude-opus-5-5', 'Claude Opus 5.5 (기본·최고 품질)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (빠름·저비용)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (최저비용)']])}</select></label>
        </div>
        <div class="row" style="margin-top:14px"><span class="spacer"></span><button class="btn primary" id="sSave">저장</button></div>
        <div id="sMsg"></div>
      </div>
      <div class="card">
        <h3>이용 안내</h3>
        <ul class="list">
          <li>AI는 <b>요구사항 텍스트 분석</b>과 <b>영업 메시지 생성</b>에 사용됩니다. 제품 선정·비교 계산은 규칙 엔진이 수행합니다.</li>
          <li>AI 미연결 시에도 모든 기능이 규칙 기반으로 동작합니다.</li>
          <li>브라우저에 저장한 API 키는 프로토타입 용도입니다. 운영 시에는 서버(.env) 방식을 사용하세요.</li>
          <li>제품·가격 데이터: <code>js/data.js</code> · 선정 로직: <code>js/engine.js</code></li>
        </ul>
      </div>
    </div>`;
  }
  viewSettings.after = () => {
    $('#sSave').onclick = () => {
      const patch = { useAI: $('#sUse').checked, model: $('#sModel').value };
      if ($('#sKey')) patch.apiKey = $('#sKey').value.trim();
      VSS.settings.set(patch); updateBadge();
      $('#sMsg').innerHTML = '<div class="notice" style="margin-top:10px">저장되었습니다.</div>';
    };
  };

  /* ------------------------------ 시작 ------------------------------ */
  const B = VSS.BRAND;
  $('#brandProduct').textContent = B.product;
  $('#brandTagline').textContent = B.tagline;
  $('#footerCompany').textContent = `${B.company}(${B.companyEn})`;
  $('#year').textContent = new Date().getFullYear();
  VSS.mountLogos(document);

  window.addEventListener('hashchange', route);
  VSS.checkServer().then(() => { updateBadge(); if (/settings/.test(location.hash)) route(); });
  VSS.storage.detect();
  updateBadge();
  route();
})();
