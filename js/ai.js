/*
 * AI 모듈 — Claude API(브라우저 직접 호출) + 데모 모드(규칙 기반) 폴백
 *
 * 프로토타입 특성상 API 키를 브라우저(localStorage)에 저장합니다.
 * 운영 전환 시에는 반드시 서버 측 프록시로 옮겨 키를 노출하지 마세요.
 */
window.VSS = window.VSS || {};

VSS.settings = (function () {
  const KEY = 'vss.settings';
  const defaults = { apiKey: '', model: 'claude-opus-5-5', useAI: true };
  let s = { ...defaults };
  try { s = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) { /* storage 불가 */ }
  return {
    get: () => ({ ...s }),
    set(patch) { s = { ...s, ...patch }; try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { } },
    aiEnabled: () => !!(s.useAI && (s.apiKey || VSS.serverKey)),
  };
})();

/* node server.js 로 실행 중이고 서버에 API 키가 설정돼 있으면 프록시(/api/claude) 사용 */
VSS.serverKey = false;
VSS.checkServer = async function () {
  if (!/^https?:/.test(location.protocol)) return false;
  try {
    const r = await fetch('/api/status');
    VSS.serverKey = r.ok && (await r.json()).serverKey === true;
  } catch (e) { VSS.serverKey = false; }
  return VSS.serverKey;
};

VSS.ai = (function () {
  const API = 'https://api.anthropic.com/v1/messages';

  async function callClaude({ system, user, schema, effort = 'low', maxTokens = 8000 }) {
    const { apiKey, model } = VSS.settings.get();
    const body = {
      model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    // 서버 키가 있으면 프록시 경유(키 비노출), 없으면 브라우저에서 직접 호출
    const viaServer = VSS.serverKey;
    const url = viaServer ? '/api/claude' : API;
    const headers = viaServer ? { 'content-type': 'application/json' } : {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    // 안전 분류기 거절 시 서버 측 대체 모델로 자동 재시도 (지원 모델에서만)
    const fallbackModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];
    let useFallback = fallbackModels.includes(model);

    for (let attempt = 0; attempt < 2; attempt++) {
      const h = { ...headers }, b = { ...body };
      if (useFallback) { h['anthropic-beta'] = 'server-side-fallback-2026-07-01'; b.fallbacks = 'default'; }
      const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(b) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data.error && data.error.message) || res.statusText;
        if (res.status === 400 && useFallback && /fallback/i.test(msg)) { useFallback = false; continue; }
        throw new Error(`Claude API 오류 (${res.status}): ${msg}`);
      }
      if (data.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 처리하지 않았습니다(refusal).');
      if (data.stop_reason === 'max_tokens') throw new Error('응답이 길이 제한으로 잘렸습니다.');
      const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
      return JSON.parse(text);
    }
    throw new Error('Claude API 호출 실패');
  }

  /* ---------------------- 1) 요구사항 텍스트 분석 ---------------------- */
  const n = t => ({ type: [t, 'null'] });
  const e = vals => ({ type: ['string', 'null'], enum: [...vals, null] });
  const REQ_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      customer: n('string'), site: n('string'),
      itLoadKW: n('number'), growthPct: n('number'),
      redundancy: e(['N', 'N+1', '2N']), upsPhase: { type: ['integer', 'null'], enum: [1, 3, null] },
      runtimeMin: n('number'), batteryType: e(['any', 'VRLA', 'Li-ion']),
      heatLoadKW: n('number'), coolingLayout: e(['any', 'room', 'inrow']), coolingMedium: e(['any', 'DX', 'CW']),
      economizer: n('boolean'), coolingRedundancy: e(['N', 'N+1', '2N']),
      rackCount: n('integer'), rackKW: n('number'), rackHeightU: { type: ['integer', 'null'], enum: [42, 47, 48, null] },
      rackWidth: { type: ['integer', 'null'], enum: [600, 750, 800, null] },
      pduPhase: { type: ['integer', 'null'], enum: [1, 3, null] }, pduLevel: e(['basic', 'metered', 'switched', 'outletMetered']),
      monitoring: n('boolean'), priority: e(['balanced', 'price', 'efficiency', 'reliability', 'space']),
      summary: { type: 'array', items: { type: 'string' } },
    },
    required: ['customer', 'site', 'itLoadKW', 'growthPct', 'redundancy', 'upsPhase', 'runtimeMin', 'batteryType', 'heatLoadKW',
      'coolingLayout', 'coolingMedium', 'economizer', 'coolingRedundancy', 'rackCount', 'rackKW', 'rackHeightU', 'rackWidth',
      'pduPhase', 'pduLevel', 'monitoring', 'priority', 'summary'],
  };

  const REQ_SYSTEM = `당신은 데이터센터 전력·냉방 인프라(UPS, 정밀공조, 랙 PDU, 랙, 모니터링) 영업 엔지니어를 돕는 요구사항 분석가입니다.
고객의 RFP·이메일·회의록에서 제품 선정에 필요한 값을 추출해 JSON으로 반환합니다.
- 문서에 명시되었거나 수치로 명확히 추론되는 값만 채우고, 근거가 없으면 null로 둡니다.
- MW는 kW로 변환합니다. kVA만 주어지면 역률 1.0으로 보고 kW로 씁니다.
- redundancy는 UPS(전력) 이중화, coolingRedundancy는 냉방 이중화입니다.
- priority는 고객이 가장 중시한다고 밝힌 기준입니다(가격/예산→price, 에너지·전기요금→efficiency, 무중단·가용성·신뢰성→reliability, 공간·면적→space).
- pduLevel: 아울렛 단위 계측→outletMetered, 원격 on/off→switched, 입력 계측→metered.
- summary에는 추출한 핵심 요구사항과, 문서에 있지만 위 필드에 담지 못한 특이 요구(인증, 납기, 브랜드 제한 등)를 한국어 짧은 문장으로 정리합니다.`;

  async function parseRequirements(text) {
    if (VSS.settings.aiEnabled()) {
      const out = await callClaude({ system: REQ_SYSTEM, user: text, schema: REQ_SCHEMA, effort: 'low' });
      return { fields: out, summary: out.summary || [], source: 'ai' };
    }
    return demoParse(text);
  }

  /* 데모 모드: 정규식 기반 추출 */
  function demoParse(text) {
    const t = text.replace(/\s+/g, ' ');
    const f = {}; const summary = [];
    const sentences = text.split(/[.\n。]/).map(s => s.trim()).filter(Boolean);
    const isPower = s => /UPS|전력|배터리|백업/i.test(s);
    const isCool = s => /냉방|공조|항온|쿨링|냉각|CRAC|CRAH|인로우/i.test(s);

    let m = t.match(/(?:IT\s*부하|부하|IT)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(MW|kW)/i) || t.match(/(\d+(?:\.\d+)?)\s*(MW|kW)(?!\s*수준)/i);
    if (m) { f.itLoadKW = parseFloat(m[1]) * (/MW/i.test(m[2]) ? 1000 : 1); summary.push(`IT 부하 ${f.itLoadKW}kW`); }
    m = t.match(/(\d+)\s*%\s*(?:증설|확장|성장)/) || t.match(/(?:증설|확장성|확장)[^\d]{0,12}(\d+)\s*%/);
    if (m) { f.growthPct = +m[1]; summary.push(`증설 여유 ${m[1]}%`); }
    const red = s => (/2N/.test(s) ? '2N' : /N\s*\+\s*1|예비\s*1/.test(s) ? 'N+1' : null);
    for (const s of sentences) {
      const r = red(s); if (!r) continue;
      if (isCool(s) && !f.coolingRedundancy) f.coolingRedundancy = r;
      if ((isPower(s) || !isCool(s)) && !f.redundancy) f.redundancy = r;
    }
    if (f.redundancy) summary.push(`UPS 이중화 ${f.redundancy}`);
    if (f.coolingRedundancy) summary.push(`냉방 이중화 ${f.coolingRedundancy}`);
    m = t.match(/(\d+)\s*분/); if (m) { f.runtimeMin = +m[1]; summary.push(`백업 시간 ${m[1]}분`); }
    if (/리튬|Li-?ion|lithium/i.test(t)) { f.batteryType = 'Li-ion'; summary.push('리튬이온 배터리'); }
    else if (/납축|VRLA/i.test(t)) f.batteryType = 'VRLA';
    if (/단상/.test(t)) { f.upsPhase = 1; f.pduPhase = 1; summary.push('단상 전원'); }
    if (/3상|삼상/.test(t)) { f.pduPhase = 3; if (!/단상/.test(t)) f.upsPhase = 3; }
    m = t.match(/(42|47|48)\s*U/i); if (m) f.rackHeightU = +m[1];
    const noU = t.replace(/\d+\s*U\b/gi, '');
    m = noU.match(/(?:랙|rack)[^\d]{0,10}(\d+)\s*(?:개|대|EA|ea)/i) || noU.match(/(\d+)\s*(?:개|대)\s*(?:의\s*)?랙/);
    if (m) { f.rackCount = +m[1]; summary.push(`랙 ${m[1]}개`); }
    m = t.match(/랙당\s*(\d+(?:\.\d+)?)\s*kW/i); if (m) { f.rackKW = parseFloat(m[1]); summary.push(`랙당 ${m[1]}kW`); }
    m = t.match(/(600|750|800)\s*mm/); if (m) f.rackWidth = +m[1];
    if (/인로우|in-?row/i.test(t)) f.coolingLayout = 'inrow';
    else if (/룸형|항온항습|CRAC|CRAH/i.test(t)) f.coolingLayout = 'room';
    if (/냉수|CW\b|chilled/i.test(t)) f.coolingMedium = 'CW'; else if (/DX|직팽/i.test(t)) f.coolingMedium = 'DX';
    if (f.coolingLayout || f.coolingMedium) summary.push(`냉방 ${f.coolingLayout === 'inrow' ? '인로우' : f.coolingLayout === 'room' ? '룸형' : ''} ${f.coolingMedium || ''}`.trim());
    if (/이코노마이저|프리\s*쿨링|free\s*cool/i.test(t)) f.economizer = true;
    if (/아울렛|outlet/i.test(t)) f.pduLevel = 'outletMetered';
    else if (/스위치드|switched|원격\s*(?:제어|on)/i.test(t)) f.pduLevel = 'switched';
    else if (/계측|metered/i.test(t)) f.pduLevel = 'metered';
    if (f.pduLevel) summary.push(`PDU ${VSS.engine.PDU_LEVEL_LABEL[f.pduLevel]}`);
    if (/DCIM|모니터링/i.test(t)) f.monitoring = true;
    const pri = [
      ['price', /가격|예산|저렴|비용/], ['efficiency', /효율|에너지|전기\s*요금|PUE/],
      ['reliability', /신뢰|가용성|무중단|안정/], ['space', /공간|면적/],
    ];
    const key = sentences.find(s => /가장|최우선|중요|중시/.test(s)) || '';
    const hit = pri.find(([, re]) => re.test(key)) || pri.find(([, re]) => re.test(t));
    if (hit) { f.priority = hit[0]; summary.push(`우선순위: ${VSS.engine.PRIORITY_LABELS[hit[0]]}`); }
    return { fields: f, summary, source: 'demo' };
  }

  /* ---------------------- 2) 영업 메시지 생성 ---------------------- */
  const TP_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      headline: { type: 'string' },
      keyMessages: { type: 'array', items: { type: 'string' } },
      objectionHandling: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, properties: { objection: { type: 'string' }, response: { type: 'string' } }, required: ['objection', 'response'] },
      },
      proposalSummary: { type: 'string' },
    },
    required: ['headline', 'keyMessages', 'objectionHandling', 'proposalSummary'],
  };
  const TP_SYSTEM = `당신은 Vertiv 데이터센터 인프라 영업을 지원하는 프리세일즈 컨설턴트입니다.
주어진 고객 요구사항과 Vertiv 추천 구성, 경쟁사 비교 데이터(JSON)만 근거로 한국어 영업 메시지를 작성합니다.
- 데이터에 없는 사양·수치·인증을 지어내지 않습니다. 수치는 입력값 그대로 인용합니다.
- headline: 고객에게 던질 한 문장 핵심 메시지.
- keyMessages: 4~6개. 고객 우선순위와 연결된 정량적 강점부터 배치합니다.
- objectionHandling: 경쟁사 대비 열세 항목에 대해 예상 반론과 대응 논리 2~4개. 열세를 부정하지 말고 TCO·기능·리스크 관점으로 재구성합니다.
- proposalSummary: 제안서 요약 단락(3~4문장).
- 가격은 샘플(가상) 데이터임을 감안해 절대 금액보다 비율·차이 중심으로 표현합니다.`;

  async function talkingPoints(cat, v, comps, req) {
    if (!VSS.settings.aiEnabled()) return VSS.engine.demoTalkingPoints(cat, v, comps, req);
    const pack = cfg => ({
      vendor: cfg.product.vendor, product: cfg.product.name, config: cfg.desc,
      metrics: Object.fromEntries(VSS.engine.METRICS[cat].map(d => [d.label, d.fmt(cfg.metrics[d.key])])),
      features: cfg.product.features.map(f => VSS.FEATURES[f]),
    });
    const payload = {
      category: VSS.CATEGORIES[cat].label,
      customerRequirements: { customer: req.customer, itLoadKW: req.itLoadKW, redundancy: req.redundancy, priority: VSS.engine.PRIORITY_LABELS[req.priority], tcoYears: req.years, notes: req.notes },
      vertiv: pack(v),
      competitors: comps.map(x => ({ ...pack(x.cfg), vertivStrengths: x.cmp.strengths.map(s => s.text), vertivWeaknesses: x.cmp.weaknesses.map(w => w.text + (w.rebuttal ? ` (${w.rebuttal})` : '')) })),
    };
    const out = await callClaude({ system: TP_SYSTEM, user: JSON.stringify(payload, null, 1), schema: TP_SCHEMA, effort: 'medium' });
    return { ...out, source: 'ai' };
  }

  return { parseRequirements, talkingPoints, demoParse };
})();
