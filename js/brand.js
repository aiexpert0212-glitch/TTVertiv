/*
 * 브랜딩 설정 — 회사명·로고는 여기서만 바꾸면 됩니다.
 * 로고 파일을 assets/ 폴더에 넣으면 자동으로 표시되고, 없으면 텍스트 워드마크를 보여줍니다.
 *   assets/logo-unipoint.svg | .png | .jpg   (회사 로고)
 *   assets/logo-vertiv.svg   | .png | .jpg   (제품 브랜드 로고, 선택)
 */
window.VSS = window.VSS || {};

VSS.BRAND = {
  company: '유니포인트',
  companyEn: 'UniPoint',
  product: 'Vertiv 솔루션 셀렉터',
  tagline: '제품 선정 · 경쟁사 비교',
  logos: {
    unipoint: { files: ['assets/logo-unipoint.svg', 'assets/logo-unipoint.png', 'assets/logo-unipoint.jpg'], alt: 'UniPoint', text: '<b>Uni</b>Point', cls: 'wm-unipoint' },
    vertiv:   { files: ['assets/logo-vertiv.svg', 'assets/logo-vertiv.png', 'assets/logo-vertiv.jpg'], alt: 'Vertiv', text: 'VERTIV', cls: 'wm-vertiv' },
  },
};

/* data-logo="unipoint" 요소에 로고 이미지(없으면 워드마크)를 채움. 결과는 캐시. */
VSS.mountLogos = (function () {
  const cache = {}; // key -> Promise<url|null>
  // 서버 실행 시에는 서버가 존재하는 파일을 알려 주고, 파일로 직접 열었을 때만 하나씩 시도
  const listed = /^https?:/.test(location.protocol)
    ? fetch('/api/logos').then(r => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);
  function resolve(key) {
    if (!cache[key]) cache[key] = (async () => {
      const known = await listed;
      if (known) return known[key] || null;
      for (const src of VSS.BRAND.logos[key].files) {
        const ok = await new Promise(r => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = src; });
        if (ok) return src;
      }
      return null;
    })();
    return cache[key];
  }
  return function mount(root = document) {
    root.querySelectorAll('[data-logo]:not([data-mounted])').forEach(async el => {
      el.dataset.mounted = '1';
      const key = el.dataset.logo, cfg = VSS.BRAND.logos[key];
      const src = await resolve(key);
      el.innerHTML = src ? `<img src="${src}" alt="${cfg.alt}">` : `<span class="wordmark ${cfg.cls}">${cfg.text}</span>`;
    });
  };
})();
