-- Vertiv 제품 선정 지원 시스템 — Supabase 스키마
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 Run 하세요. (여러 번 실행해도 안전)

create table if not exists public.comparisons (
  id          bigint generated always as identity primary key,
  name        text        not null,
  customer    text        default '',
  site        text        default '',
  summary     jsonb       not null,   -- 목록 표시용
  data        jsonb       not null,   -- 전체 스냅샷 (요구사항·결과·선택·영업 메시지)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists comparisons_updated_at_idx on public.comparisons (updated_at desc);

alter table public.comparisons enable row level security;

-- ⚠ publishable(anon) 키로 읽기·쓰기·삭제를 허용하는 정책
--   프로젝트 주소와 publishable 키를 아는 사람은 누구나 저장된 비교를 보고 삭제할 수 있습니다.
--   샘플 데이터 테스트용이며, 실제 가격·고객 정보를 넣기 전에 로그인 기반 정책으로 바꾸세요.
grant select, insert, update, delete on public.comparisons to anon;

drop policy if exists "anon read"   on public.comparisons;
drop policy if exists "anon insert" on public.comparisons;
drop policy if exists "anon update" on public.comparisons;
drop policy if exists "anon delete" on public.comparisons;
create policy "anon read"   on public.comparisons for select to anon using (true);
create policy "anon insert" on public.comparisons for insert to anon with check (true);
create policy "anon update" on public.comparisons for update to anon using (true) with check (true);
create policy "anon delete" on public.comparisons for delete to anon using (true);

-- API가 새 테이블을 바로 인식하도록 스키마 캐시 갱신
notify pgrst, 'reload schema';
