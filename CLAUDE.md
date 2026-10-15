# Vertiv 솔루션 셀렉터 — 인수인계 문서

> 이 문서는 Claude Code가 새 세션에서 자동으로 읽습니다. 작업을 이어갈 때 먼저 확인하세요.
> **사용자와는 한국어로 대화합니다.** (영어 설명은 이해하기 어렵다고 요청함)

## 1. 프로젝트 개요
- **목적**: 고객 요구사항을 분석해 최적의 Vertiv 제품을 선정하고, 경쟁사 제품과 사양·성능·가격(TCO)을 비교해 강점·차별화 요소와 영업 메시지를 도출하는 웹 시스템.
- **사용 회사**: 유니포인트(UniPoint) — Vertiv 총판. 내부 업무용.
- **단계**: 시연용 프로토타입 완성. 제품 사양은 공개 자료 기반 근사치, **가격은 모두 가상값**.
- **GitHub**: https://github.com/aiexpert0212-glitch/TTVertiv (`main` 브랜치)
- 상세 요구사항·로드맵은 [prd.md](prd.md), 사용법은 [README.md](README.md) 참고.

## 2. 실행 방법
```bash
node server.js
```
- 브라우저에서 http://localhost:3000 접속. 외부 npm 패키지 없음 (Node 내장 모듈만 사용, Node v24 필요 — `node:sqlite` 사용).
- Node 설치 전에 열린 PowerShell 창에서는 `node`를 못 찾음 → 창을 새로 열거나 PATH 새로고침.
- 포트 3000이 이미 쓰이면 서버가 한글로 안내 후 종료. 다른 포트는 `.env`의 `PORT`.
- Claude 브라우저 미리보기용 설정: `.claude/launch.json` (이름 `vss`).

## 3. 파일 구조
| 파일 | 역할 |
|---|---|
| `index.html` | 화면 틀 (상단바·메뉴·푸터) |
| `css/style.css` | 전체 스타일. 색상 토큰은 `:root` (라이트/다크) |
| `js/brand.js` | 회사명·제품명·로고 설정 + 로고 표시(`VSS.mountLogos`) |
| `js/data.js` | 제품·경쟁사 샘플 DB(`VSS.PRODUCTS`), 기능 라벨, **고객사 목록(`VSS.CUSTOMERS`)**, 데모 시나리오 |
| `js/engine.js` | 용량 산정·점수화·경쟁사 비교·강점 도출 (규칙 엔진) |
| `js/ai.js` | Claude API 연동 코드(현재 미사용) + 규칙 기반 요구사항 추출(`demoParse`) |
| `js/storage.js` | 저장된 비교 저장소 (서버 DB ↔ 브라우저 자동 선택) |
| `js/app.js` | 화면 렌더링·해시 라우팅 (`#/`, `#/input`, `#/results`, `#/compare`, `#/report`, `#/saved`, `#/db`, `#/settings`) |
| `server.js` | 정적 파일 + `/api/comparisons`(Supabase 또는 SQLite) + `/api/logos` + `/api/status` + Claude 프록시 |
| `supabase/schema.sql` | Supabase 테이블·접근 정책 |
| `assets/` | `logo-unipoint.png`, `logo-vertiv.png`(배경 투명 처리), `hero-bg.jpg`(홈 배경) |

## 4. 지금까지 결정된 사항 (바꾸기 전에 사용자 확인)
- **AI(Claude API) 연동 안 함.** 요구사항 분석·영업 메시지는 규칙 기반. 코드는 남겨 두어 `.env`에 `ANTHROPIC_API_KEY`를 넣으면 켜짐.
- **저장소: Supabase + publishable 키.** 사용자가 secret 키 사용을 거부함. `schema.sql`의 anon 정책으로 publishable 키가 읽기·쓰기·삭제 가능
  → 프로젝트 주소+키를 알면 누구나 접근 가능하므로 **샘플 데이터 테스트용**. 실제 가격·고객 정보를 넣기 전에 반드시 사용자와 보안 방식(secret 키 또는 로그인 정책) 재논의.
  - `.env`: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`(이름은 이렇지만 현재 publishable 키가 들어 있음, `SUPABASE_KEY`도 인식). Supabase 설정이 없으면 SQLite(`data/vss.db`)로 자동 전환.
  - Supabase `jsonb`는 객체 키 순서를 보존하지 않음 → 저장본을 열 때 제품군 순서를 `VSS.CATEGORIES` 순서로 복원함(`restore()`).
- **고객사는 목록에서 선택** (`VSS.CUSTOMERS`, 데모 6개). 데모 시나리오 선택 시 고객사 자동 지정.
- **전기요금·TCO 기간은 화면에서 입력하지 않음** → 기본값 150원/kWh, 10년 고정 (추천 결과 "선정 기준"에 표시).
- 제품 화면 이름은 **"제품 리스트"** (경로는 `#/db` 그대로).

## 5. 디자인 규칙
- **색상**: 유니포인트 로고 블루 `#4657A5`(주 색상, `--accent`), 오렌지 `#E87E00`(포인트, `--dot`), 상단 메뉴 밑줄 하늘색 `#4DA3EE`(`--nav-bar`). Vertiv 제품은 차트·표에서 Vertiv 오렌지 `#E8590C`(`VSS.VENDORS`)로 구분.
- **홈 히어로**: 회로 패턴 배경(원본 이미지의 로고를 지우고 좌우 반전 합성) + 남색 반투명 오버레이 + 흰 글씨. 설명 문구는 960px 이상에서 한 줄.
- **줄바꿈 규칙**: 박스·표·태그·버튼·입력칸 이름 등 **짧은 문구는 한 줄 고정**(`.one-line`, 넘치면 … + 마우스 툴팁 자동). 강점·약점·영업 메시지 같은 **긴 문장은 줄바꿈 허용**.
- 상단 메뉴: 마우스 오버 시 굵게(폭 흔들림 방지 `data-text`). 푸터는 항상 화면 하단.
- 링크형 버튼(`.btn`)은 밑줄 없음. 다크 모드 지원(로고는 흰 칩 위에 표시).
- 화면 변경 후에는 데스크톱(1280)·태블릿(900)·휴대폰(375) 폭에서 확인해 왔음.

## 6. 작업 방식 메모
- 커밋 메시지는 한국어. PowerShell 5.1에서는 여러 줄 메시지를 임시 파일로 저장 후 `git commit -F <파일>` 사용 (here-string 파이프가 안 됨).
- 사용자가 요청할 때만 커밋·푸시. `.env`와 `data/*.db`는 `.gitignore`로 제외됨.
- GitHub 인증은 Windows 자격 증명에 저장되어 있어 `git push` 바로 가능.
- 이미지 가공은 PowerShell `System.Drawing`으로 처리해 왔음 (Python Pillow 없음).

## 7. 남은 할 일 (우선순위 순)
1. **실제 데이터 반영**: `js/data.js`의 사양·가격을 실제 자료로 교체. 바탕화면 `업무\02_영업_제안\01_영업\2026 Vertiv\1. 단가표\`에 Vertiv 단가표 엑셀이 있음(사용자 확인 후 사용).
   ⚠ GitHub 저장소가 공개일 수 있으므로 **실제 가격을 커밋하기 전에 저장소 공개 여부 확인** 필요.
2. 데이터 관리 기능: 엑셀 업로드 또는 화면에서 제품 추가·수정 (현재는 `data.js` 직접 수정).
3. 보안: 로그인·권한(가격 열람 제한), Supabase 정책 강화.
4. 선정 로직 검증: 과거 수주 건 5~10개로 추천 결과와 실제 구성 비교.
5. 고객사 목록을 실제 고객사로 교체 (`VSS.CUSTOMERS`).
6. 사내 서버 배포 (IT 승인 필요).
