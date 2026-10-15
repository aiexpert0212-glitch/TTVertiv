/*
 * 제품 선정 · 점수화 · 경쟁사 비교 엔진
 * 모든 금액 단위는 만원(가상가), 전력량은 kWh 입니다.
 */
window.VSS = window.VSS || {};

VSS.fmt = {
  won(man) {
    if (man == null || isNaN(man)) return '-';
    const v = Math.round(man);
    if (Math.abs(v) >= 10000) return '₩' + (v / 10000).toFixed(2).replace(/\.?0+$/, '') + '억';
    return '₩' + v.toLocaleString('ko-KR') + '만';
  },
  num(v, d = 0) { return v == null || isNaN(v) ? '-' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }); },
  kwh(v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + ' GWh' : v >= 1e4 ? (v / 1000).toFixed(1) + ' MWh' : Math.round(v).toLocaleString('ko-KR') + ' kWh'; },
  pct(v, d = 1) { return (v * 100).toFixed(d) + '%'; },
};

VSS.engine = (function () {
  const F = VSS.fmt;
  const has = (p, f) => p.features.includes(f);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const MAINT_RATE = 0.03; // 연간 유지보수비 = 초기투자비 × 3% (전 제조사 동일 가정)

  /* 우선순위별 역할 가중치 */
  const ROLE_WEIGHTS = {
    balanced:    { cost: 1.0, efficiency: 1.0, tco: 1.2, space: 0.6, scalability: 0.8, features: 0.8, reliability: 0.8 },
    price:       { cost: 2.5, efficiency: 0.5, tco: 1.0, space: 0.4, scalability: 0.4, features: 0.4, reliability: 0.4 },
    efficiency:  { cost: 0.6, efficiency: 2.0, tco: 2.0, space: 0.4, scalability: 0.6, features: 0.6, reliability: 0.6 },
    reliability: { cost: 0.6, efficiency: 0.8, tco: 0.8, space: 0.4, scalability: 1.5, features: 1.6, reliability: 2.0 },
    space:       { cost: 0.8, efficiency: 0.8, tco: 0.8, space: 2.5, scalability: 1.0, features: 0.6, reliability: 0.6 },
  };
  const PRIORITY_LABELS = { balanced: '균형', price: '가격 우선', efficiency: '에너지 효율 우선', reliability: '신뢰성·확장성 우선', space: '공간 절감 우선' };

  /* 카테고리별 비교 지표 정의 */
  const METRICS = {
    ups: [
      { key: 'capex', label: '초기 투자비', role: 'cost', better: 'low', fmt: F.won },
      { key: 'eff', label: '운전 효율(부하율 반영)', role: 'efficiency', better: 'high', fmt: v => v.toFixed(2) + '%', scoreValue: v => 100 - v, scoreDir: 'low' },
      { key: 'tco', label: 'TCO', role: 'tco', better: 'low', fmt: F.won },
      { key: 'footprint', label: '설치 면적', role: 'space', better: 'low', fmt: v => v.toFixed(2) + ' m²' },
      { key: 'scalability', label: '확장성', role: 'scalability', better: 'high', fmt: v => v + '점' },
      { key: 'features', label: '주요 기능 수', role: 'features', better: 'high', fmt: v => v + '개' },
    ],
    thermal: [
      { key: 'capex', label: '초기 투자비', role: 'cost', better: 'low', fmt: F.won },
      { key: 'seer', label: '연간 실효 EER', role: 'efficiency', better: 'high', fmt: v => v.toFixed(2) },
      { key: 'tco', label: 'TCO', role: 'tco', better: 'low', fmt: F.won },
      { key: 'footprint', label: '설치 면적', role: 'space', better: 'low', fmt: v => v.toFixed(2) + ' m²' },
      { key: 'features', label: '주요 기능 수', role: 'features', better: 'high', fmt: v => v + '개' },
    ],
    pdu: [
      { key: 'capex', label: '초기 투자비', role: 'cost', better: 'low', fmt: F.won },
      { key: 'accuracy', label: '계측 정확도', role: 'efficiency', better: 'low', fmt: v => '±' + v + '%' },
      { key: 'maxTemp', label: '최대 운용온도', role: 'reliability', better: 'high', fmt: v => v + '°C' },
      { key: 'daisyChain', label: 'IP당 연결 대수', role: 'scalability', better: 'high', fmt: v => v + '대' },
      { key: 'features', label: '주요 기능 수', role: 'features', better: 'high', fmt: v => v + '개' },
    ],
    rack: [
      { key: 'capex', label: '초기 투자비', role: 'cost', better: 'low', fmt: F.won },
      { key: 'staticKg', label: '정하중', role: 'reliability', better: 'high', fmt: v => v.toLocaleString() + ' kg' },
      { key: 'perforation', label: '도어 통기율', role: 'efficiency', better: 'high', fmt: v => v + '%' },
      { key: 'features', label: '주요 기능 수', role: 'features', better: 'high', fmt: v => v + '개' },
    ],
    monitoring: [
      { key: 'capex', label: '초기 투자비', role: 'cost', better: 'low', fmt: F.won },
      { key: 'coverage', label: '기능 커버리지', role: 'features', better: 'high', fmt: v => v + '%' },
      { key: 'maxDevices', label: '최대 관리 장비', role: 'scalability', better: 'high', fmt: v => v.toLocaleString() + '대' },
    ],
  };

  function defaultReq() {
    return {
      customer: '', site: '',
      categories: { ups: true, thermal: true, pdu: true, rack: true, monitoring: true },
      priority: 'balanced', electricityRate: 150, years: 10, growthPct: 20,
      itLoadKW: 200, redundancy: 'N+1', upsPhase: 3, runtimeMin: 10, batteryType: 'any', maxLoadingPct: 80,
      heatLoadKW: null, coolingLayout: 'any', coolingMedium: 'any', economizer: true, coolingRedundancy: 'N+1',
      rackCount: 40, rackKW: null, rackHeightU: 42, rackWidth: 600, rackDepth: 1200,
      pduPhase: 3, pduLevel: 'metered',
      notes: '',
    };
  }

  /* 파생 값 */
  function derived(req) {
    const g = 1 + (req.growthPct || 0) / 100;
    const heat = req.heatLoadKW > 0 ? req.heatLoadKW : req.itLoadKW * g * 1.1;
    const rackKW = req.rackKW > 0 ? req.rackKW : (req.rackCount > 0 ? req.itLoadKW * g / req.rackCount : 0);
    return { growth: g, heatKW: heat, rackKW };
  }

  /* ------------------------------ UPS ------------------------------ */
  function effAt(p, loading) {
    let pen = loading < 0.2 ? 2.0 : loading < 0.3 ? 1.2 : loading < 0.4 ? 0.6 : loading < 0.5 ? 0.3 : 0;
    if (has(p, 'intelligentParalleling')) pen *= 0.4; // 저부하 시 모듈 휴지로 효율 저하 완화
    return p.effDouble - pen;
  }

  function sizeUPS(p, req, d) {
    if (p.phase !== Number(req.upsPhase)) return null;
    if (req.batteryType === 'Li-ion' && !has(p, 'liIon')) return null;
    const load = req.itLoadKW;
    const design = load * d.growth / ((req.maxLoadingPct || 80) / 100);
    const sys = req.redundancy === '2N' ? 2 : 1;
    const nPlus = req.redundancy === 'N+1' ? 1 : 0;
    let units, unitKW, desc, capex;

    if (p.modular) {
      const m = p.modular;
      const modules = Math.ceil(design / m.moduleKW) + nPlus;
      const capacity = Math.max(modules * m.moduleKW, m.minKW);
      const frames = Math.ceil(capacity / m.maxKW);
      if (frames > p.maxParallel) return null;
      const perFrame = Math.ceil(capacity / m.moduleKW / frames);
      unitKW = Math.max(perFrame * m.moduleKW, m.minKW);
      units = frames * sys;
      capex = units * (p.priceBase + p.pricePerKW * unitKW);
      desc = `${unitKW}kW 프레임(${perFrame}×${m.moduleKW}kW 모듈) × ${frames}대` + (sys === 2 ? ' × 2계통' : '') +
        (nPlus ? ' · 모듈 N+1' : '');
    } else {
      let best = null;
      for (const r of p.ratingsKW) {
        const n = Math.ceil(design / r) + nPlus;
        if (n > p.maxParallel) continue;
        const cost = n * sys * (p.priceBase + p.pricePerKW * r);
        if (!best || cost < best.cost) best = { r, n, cost };
      }
      if (!best) return null;
      unitKW = best.r; units = best.n * sys; capex = best.cost;
      desc = `${unitKW}kW × ${best.n}대` + (best.n > 1 ? ' 병렬' : '') + (sys === 2 ? ' × 2계통' : '') + (nPlus ? ' (N+1)' : '');
    }

    const installed = unitKW * units;
    const loading = load / installed;
    const eff = effAt(p, loading);
    // UPS 손실 + 손실열 냉방전력(×1.3)
    const annualLossKWh = load * (100 / eff - 1) * 8760 * 1.3;
    const annualCost = annualLossKWh * req.electricityRate / 10000;
    const maint = capex * MAINT_RATE;
    const tco = capex + (annualCost + maint) * req.years;
    const footprint = units * (p.fpBase + p.fpPerKW * unitKW);
    const maxCap = (p.modular ? p.modular.maxKW : Math.max(...p.ratingsKW)) * p.maxParallel;
    let scal = p.modular ? 55 : 30;
    if (has(p, 'hotSwapModule')) scal += 15;
    if (has(p, 'parallel')) scal += 10;
    scal += clamp(Math.round((maxCap / (installed / sys) - 1) * 5), 0, 20);

    return {
      product: p, desc, qty: units, unitKW, installedKW: installed,
      metrics: { capex, eff, tco, footprint, scalability: clamp(scal, 0, 100), features: p.features.length },
      info: [
        ['설치 용량', F.num(installed) + ' kW'],
        ['부하율', F.pct(loading, 0)],
        ['연간 손실전력(냉방 포함)', F.kwh(annualLossKWh)],
        ['연간 손실 전기요금', F.won(annualCost)],
        ['배터리 백업', req.runtimeMin + '분 (' + (req.batteryType === 'any' ? 'VRLA/Li-ion' : req.batteryType) + ', 별도 산정)'],
      ],
      energy: { annualKWh: annualLossKWh, annualCost, maint },
    };
  }

  /* ---------------------------- 정밀공조 ---------------------------- */
  function sizeThermal(p, req, d) {
    if (req.coolingLayout !== 'any' && p.type !== req.coolingLayout) return null;
    if (req.coolingMedium !== 'any' && p.medium !== req.coolingMedium) return null;
    const heat = d.heatKW;
    let best = null;
    for (const r of p.ratingsKW) {
      let n = Math.ceil(heat / r);
      if (req.coolingRedundancy === 'N+1') n += 1;
      if (req.coolingRedundancy === '2N') n *= 2;
      if (n > 40) continue;
      const cost = n * (p.priceBase + p.pricePerKW * r);
      if (!best || cost < best.cost) best = { r, n, cost };
    }
    if (!best) return null;
    const eerEff = p.medium === 'CW' ? 1 / (1 / p.eer + 1 / 4.5) : p.eer; // CW는 칠러(COP 4.5) 전력 포함
    const econ = req.economizer ? p.econSaving : 0;
    const seer = eerEff / (1 - econ);
    const annualKWh = heat / seer * 8760;
    const annualCost = annualKWh * req.electricityRate / 10000;
    const capex = best.cost;
    const maint = capex * MAINT_RATE;
    const tco = capex + (annualCost + maint) * req.years;
    const footprint = best.n * (p.fpBase + p.fpPerKW * best.r);
    return {
      product: p, desc: `${best.r}kW × ${best.n}대` + (req.coolingRedundancy !== 'N' ? ` (${req.coolingRedundancy})` : ''),
      qty: best.n, unitKW: best.r, installedKW: best.r * best.n,
      metrics: { capex, seer, tco, footprint, features: p.features.length },
      info: [
        ['방식', (p.type === 'inrow' ? '인로우' : '룸형') + ' / ' + p.medium],
        ['설계 열부하', F.num(heat, 0) + ' kW'],
        ['설치 냉방용량', F.num(best.r * best.n) + ' kW'],
        ['이코노마이저 절감률', econ ? F.pct(econ, 0) : '미적용'],
        ['연간 냉방 전력', F.kwh(annualKWh)],
        ['연간 냉방 전기요금', F.won(annualCost)],
      ],
      energy: { annualKWh, annualCost, maint },
    };
  }

  /* ------------------------------ PDU ------------------------------ */
  const PDU_LEVEL_PRICE = { basic: 60, metered: 110, switched: 170, outletMetered: 220 };
  const PDU_LEVEL_LABEL = { basic: 'Basic', metered: 'Metered(입력 계측)', switched: 'Switched(원격 제어)', outletMetered: 'Outlet-Metered(아울렛 계측+제어)' };

  function sizePDU(p, req, d) {
    if (!p.levels.includes(req.pduLevel)) return null;
    const ph = Number(req.pduPhase);
    const opts = p.ratings.filter(r => r.phase === ph)
      .map(r => ({ ...r, kw: (ph === 1 ? 230 * r.amps : 400 * Math.sqrt(3) * r.amps) * 0.8 / 1000 }))
      .sort((a, b) => a.kw - b.kw);
    const pick = opts.find(o => o.kw >= d.rackKW);
    if (!pick) return null;
    const qty = req.rackCount * 2; // A/B 이중 피드
    const unit = PDU_LEVEL_PRICE[req.pduLevel] * (ph === 3 ? 1.3 : 1) * (pick.amps > 16 ? 1.15 : 1) * p.priceFactor;
    const capex = qty * unit;
    return {
      product: p, desc: `${ph}상 ${pick.amps}A ${PDU_LEVEL_LABEL[req.pduLevel]} × ${qty}대 (A/B 피드)`,
      qty, unitKW: pick.kw, installedKW: pick.kw * qty,
      metrics: { capex, accuracy: p.accuracyPct, maxTemp: p.maxTempC, daisyChain: p.daisyChain, features: p.features.length },
      info: [
        ['랙당 설계부하', F.num(d.rackKW, 1) + ' kW'],
        ['PDU 정격(80% 디레이팅)', F.num(pick.kw, 1) + ' kW'],
        ['콘센트 수', p.outlets + '구'],
      ],
    };
  }

  /* ------------------------------ 랙 ------------------------------ */
  function sizeRack(p, req) {
    const h = p.heights.find(x => Math.abs(x - req.rackHeightU) <= 1);
    if (!h) return null;
    if (!p.widths.includes(Number(req.rackWidth))) return null;
    const depth = p.depths.filter(x => x >= req.rackDepth - 50).sort((a, b) => a - b)[0];
    if (!depth) return null;
    const unit = p.priceUnit * (h >= 47 ? 1.1 : 1) * (req.rackWidth >= 750 ? 1.15 : 1);
    const capex = unit * req.rackCount;
    return {
      product: p, desc: `${h}U ${req.rackWidth}W×${depth}D × ${req.rackCount}대`,
      qty: req.rackCount,
      metrics: { capex, staticKg: p.staticKg, perforation: p.perforationPct, features: p.features.length },
      info: [['규격', `${h}U / ${req.rackWidth}×${depth}mm`], ['정하중', p.staticKg + ' kg']],
    };
  }

  /* ---------------------------- 모니터링 ---------------------------- */
  const MON_FEATURES = ['alarmMgmt', 'trending', 'energyReport', 'multiVendor', 'capacityPlanning', 'assetMgmt', 'mobileApp', 'cloud', 'onPremise'];
  function sizeMonitoring(p, req, d) {
    const devices = Math.ceil(req.rackCount * 2 + req.itLoadKW / 100 + 2 + d.heatKW / 50 + 1 + req.rackCount / 2);
    if (devices > p.maxDevices) return null;
    const capex = p.priceBase + p.pricePerDevice * devices;
    const coverage = Math.round(p.features.filter(f => MON_FEATURES.includes(f)).length / MON_FEATURES.length * 100);
    return {
      product: p, desc: `관리 대상 약 ${devices}개 장비`, qty: 1,
      metrics: { capex, coverage, maxDevices: p.maxDevices },
      info: [['관리 장비(추정)', devices + '대'], ['최대 관리 장비', p.maxDevices.toLocaleString() + '대']],
    };
  }

  const SIZERS = { ups: sizeUPS, thermal: sizeThermal, pdu: sizePDU, rack: sizeRack, monitoring: sizeMonitoring };

  /* ------------------------------ 점수화 ------------------------------ */
  function scoreCandidates(cands, defs, priority) {
    const W = ROLE_WEIGHTS[priority] || ROLE_WEIGHTS.balanced;
    for (const def of defs) {
      const dir = def.scoreDir || def.better;
      const sv = c => (def.scoreValue ? def.scoreValue(c.metrics[def.key]) : c.metrics[def.key]);
      const vals = cands.map(sv);
      const best = dir === 'high' ? Math.max(...vals) : Math.min(...vals);
      cands.forEach((c, i) => {
        const v = vals[i];
        let s = dir === 'high' ? (best > 0 ? 100 * v / best : 100) : (v > 0 ? 100 * best / v : 100);
        c.scores = c.scores || {};
        c.scores[def.key] = Math.round(clamp(s, 0, 100));
      });
    }
    for (const c of cands) {
      let sum = 0, wsum = 0;
      for (const def of defs) { const w = W[def.role] || 0.5; sum += w * c.scores[def.key]; wsum += w; }
      c.score = Math.round(sum / wsum);
    }
    cands.sort((a, b) => b.score - a.score);
  }

  function reasonsFor(cfg, cands, defs, req) {
    const out = [];
    for (const def of defs) {
      const rank = [...cands].sort((a, b) => b.scores[def.key] - a.scores[def.key]).indexOf(cfg) + 1;
      if (rank === 1 && cands.length > 1) out.push(`${def.label} 1위 (${def.fmt(cfg.metrics[def.key])})`);
    }
    const p = cfg.product;
    if (cfg.category === 'ups') {
      if (has(p, 'modular')) out.push('모듈 단위 증설로 단계적 투자 가능');
      if (has(p, 'dynamicOnline')) out.push('다이내믹 온라인 모드로 최대 99% 효율 운전 가능');
      if (req.batteryType === 'Li-ion' && has(p, 'liIon')) out.push('리튬이온 배터리 요구 충족');
    }
    if (cfg.category === 'thermal' && req.economizer && p.econSaving) out.push(`이코노마이저로 냉방 전력 약 ${Math.round(p.econSaving * 100)}% 절감`);
    return out.slice(0, 5);
  }

  function run(req) {
    const d = derived(req);
    const result = { req: JSON.parse(JSON.stringify(req)), derived: d, categories: {} };
    for (const cat of Object.keys(SIZERS)) {
      if (!req.categories[cat]) continue;
      const defs = METRICS[cat];
      const cands = [];
      for (const p of VSS.PRODUCTS.filter(x => x.category === cat)) {
        const cfg = SIZERS[cat](p, req, d);
        if (cfg) { cfg.category = cat; cfg.id = p.id; cands.push(cfg); }
      }
      if (!cands.length) { result.categories[cat] = { defs, candidates: [], empty: true }; continue; }
      scoreCandidates(cands, defs, req.priority);
      cands.forEach(c => { c.reasons = reasonsFor(c, cands, defs, req); });
      const byVendor = {};
      for (const c of cands) if (!byVendor[c.product.vendor]) byVendor[c.product.vendor] = c;
      const vertiv = cands.filter(c => VSS.VENDORS[c.product.vendor].self);
      result.categories[cat] = { defs, candidates: cands, vertiv, byVendor, selectedId: vertiv[0] ? vertiv[0].id : null };
    }
    return result;
  }

  /* --------------------------- 경쟁사 비교 --------------------------- */
  function compare(v, c, defs, req) {
    const rows = [], strengths = [], weaknesses = [];
    const years = req.years;
    const rel = (a, b) => (b === 0 ? 0 : (a - b) / Math.abs(b));
    for (const def of defs) {
      const a = v.metrics[def.key], b = c.metrics[def.key];
      const better = def.better === 'high' ? a > b : a < b;
      const tie = Math.abs(rel(a, b)) < 0.005;
      rows.push({ def, v: a, c: b, winner: tie ? 'tie' : better ? 'v' : 'c' });
    }
    const pct = (a, b) => Math.abs(rel(a, b) * 100).toFixed(0) + '%';

    // 효율
    if (v.energy && c.energy) {
      const dk = c.energy.annualKWh - v.energy.annualKWh;
      const dc = c.energy.annualCost - v.energy.annualCost;
      const label = v.category === 'ups' ? 'UPS 손실전력' : '냉방 전력';
      const effTxt = v.category === 'ups'
        ? `운전 효율 ${v.metrics.eff.toFixed(2)}% vs ${c.metrics.eff.toFixed(2)}%`
        : `연간 실효 EER ${v.metrics.seer.toFixed(2)} vs ${c.metrics.seer.toFixed(2)}`;
      if (dk > 100) strengths.push({ role: 'efficiency', text: `${effTxt} → 연간 ${label} ${F.kwh(dk)} 절감 (약 ${F.won(dc)}/년)` });
      else if (dk < -100) weaknesses.push({ role: 'efficiency', text: `${effTxt} → 연간 ${label} ${F.kwh(-dk)} 많음` });
    }
    // 초기비용 & TCO & 회수기간
    let payback = null;
    if (v.metrics.capex != null) {
      const dCap = v.metrics.capex - c.metrics.capex;
      if (dCap < -0.01 * c.metrics.capex) strengths.push({ role: 'cost', text: `초기 투자비 ${pct(v.metrics.capex, c.metrics.capex)} 저렴 (${F.won(v.metrics.capex)} vs ${F.won(c.metrics.capex)})` });
      else if (dCap > 0.01 * c.metrics.capex) {
        let t = `초기 투자비 ${pct(v.metrics.capex, c.metrics.capex)} 높음 (${F.won(v.metrics.capex)} vs ${F.won(c.metrics.capex)})`;
        let rebuttal = null;
        if (v.energy && c.energy) {
          const yearly = (c.energy.annualCost + c.energy.maint) - (v.energy.annualCost + v.energy.maint);
          if (yearly > 0 && dCap / yearly <= years) { payback = dCap / yearly; rebuttal = `운영비 절감(연 ${F.won(yearly)})으로 약 ${payback.toFixed(1)}년 내 차액 회수`; }
        }
        weaknesses.push({ role: 'cost', text: t, rebuttal });
      }
    }
    if (v.metrics.tco != null) {
      const dT = c.metrics.tco - v.metrics.tco;
      if (dT > 0.005 * c.metrics.tco) strengths.push({ role: 'tco', text: `${years}년 TCO ${F.won(dT)} 절감 (${pct(v.metrics.tco, c.metrics.tco)} 유리)` });
      else if (dT < -0.005 * c.metrics.tco) weaknesses.push({ role: 'tco', text: `${years}년 TCO ${F.won(-dT)} 불리` });
    }
    // 기타 지표
    for (const r of rows) {
      if (['capex', 'eff', 'seer', 'tco', 'features'].includes(r.def.key) || r.winner === 'tie') continue;
      const txt = `${r.def.label} ${r.def.fmt(r.v)} vs ${r.def.fmt(r.c)}`;
      if (r.winner === 'v') strengths.push({ role: r.def.role, text: txt + ' 우위' });
      else weaknesses.push({ role: r.def.role, text: txt + ' 열세' });
    }
    // 기능 차이
    const onlyV = v.product.features.filter(f => !c.product.features.includes(f));
    const onlyC = c.product.features.filter(f => !v.product.features.includes(f));
    if (onlyV.length) strengths.push({ role: 'features', text: '차별 기능: ' + onlyV.map(f => VSS.FEATURES[f]).join(', ') });
    if (onlyC.length) weaknesses.push({ role: 'features', text: '경쟁사 보유 기능: ' + onlyC.map(f => VSS.FEATURES[f]).join(', ') });

    const wins = rows.filter(r => r.winner === 'v').length, losses = rows.filter(r => r.winner === 'c').length;
    return { rows, strengths, weaknesses, onlyV, onlyC, payback, wins, losses };
  }

  /* 데모 모드용 영업 메시지 (규칙 기반) */
  function demoTalkingPoints(cat, v, comps, req) {
    const catLabel = VSS.CATEGORIES[cat].label;
    const all = comps.map(x => ({ vendor: x.cfg.product.vendor, name: x.cfg.product.name, cmp: x.cmp }));
    const topS = [];
    for (const x of all) for (const s of x.cmp.strengths.slice(0, 2)) topS.push(`[vs ${VSS.VENDORS[x.vendor].short}] ${s.text}`);
    const objections = [];
    for (const x of all) for (const w of x.cmp.weaknesses) {
      if (w.role === 'cost') objections.push({
        objection: `${x.name} 대비 초기 비용이 높다`,
        response: w.rebuttal ? `${w.rebuttal}. ${req.years}년 총소유비용(TCO) 관점에서 비교를 제안합니다.` : '초기 비용 차이는 기능·서비스 범위 차이로 설명하고, 옵션 조정으로 사양을 맞춘 대안 구성을 제시합니다.',
      });
    }
    const effWins = all.filter(x => x.cmp.strengths.some(s => s.role === 'efficiency')).map(x => VSS.VENDORS[x.vendor].short);
    const keyMessages = [];
    keyMessages.push(`${v.product.name} — ${v.desc} 구성으로 고객 요구(${PRIORITY_LABELS[req.priority]})에 최적화`);
    if (effWins.length) keyMessages.push(`${effWins.join('·')} 대비 운영 전력 절감 → ${req.years}년 TCO 우위`);
    const uniq = new Set(); all.forEach(x => x.cmp.onlyV.forEach(f => uniq.add(VSS.FEATURES[f])));
    if (uniq.size) keyMessages.push('차별화 기능: ' + [...uniq].slice(0, 4).join(', '));
    keyMessages.push(...topS.slice(0, 4));
    return {
      headline: `${catLabel}: ${v.product.name} 제안 — 경쟁 ${all.length}사 대비 ${all.reduce((a, x) => a + x.cmp.wins, 0)}개 지표 우위`,
      keyMessages,
      objectionHandling: objections.slice(0, 3),
      proposalSummary: `${req.customer || '고객사'}의 요구사항(IT ${req.itLoadKW}kW, ${req.redundancy} 이중화)을 기준으로 ${v.product.name}을(를) 추천합니다. ` +
        `초기 투자비 ${F.won(v.metrics.capex)}` + (v.metrics.tco ? `, ${req.years}년 TCO ${F.won(v.metrics.tco)}` : '') + ' 수준이며, 상세 비교 결과 위 강점을 중심으로 제안하는 것을 권장합니다.',
      source: 'demo',
    };
  }

  return { run, compare, defaultReq, derived, demoTalkingPoints, METRICS, PRIORITY_LABELS, PDU_LEVEL_LABEL, ROLE_WEIGHTS };
})();
