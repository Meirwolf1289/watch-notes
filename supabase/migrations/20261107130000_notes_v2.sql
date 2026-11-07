-- 002: wrist line + language, note status, per-note cost, daily spend cap.
-- All note columns are nullable / defaulted, so the old function keeps inserting fine.

alter table public.notes
  add column if not exists wrist         text,                        -- <= 60 chars, one line for the watch notification
  add column if not exists language      text,                        -- 'he' | 'en' | 'mixed' | 'other'
  add column if not exists status        text not null default 'ok',  -- 'ok' | 'failed'
  add column if not exists error_code    text,
  add column if not exists model         text,
  add column if not exists input_tokens  int,
  add column if not exists output_tokens int,
  add column if not exists cost_usd      numeric(10,6),
  add column if not exists latency_ms    int;

-- usage: one row per UTC day, bumped atomically by pocket_consume()
create table if not exists public.usage (
  day   date primary key,
  calls int    not null default 0,
  chars bigint not null default 0
);

-- RLS on, no policies: service role (the Edge Function) only, same as notes
alter table public.usage enable row level security;

-- Atomic "count this call and tell me if we're still under the cap".
-- Keeps counting past the cap on purpose (forensics after a key leak).
create or replace function public.pocket_consume(
  p_chars     int,
  p_max_calls int,
  p_max_chars bigint
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_calls int;
  v_chars bigint;
begin
  insert into public.usage as u (day, calls, chars)
  values (current_date, 1, greatest(p_chars, 0))
  on conflict (day) do update
    set calls = u.calls + 1,
        chars = u.chars + excluded.chars
  returning u.calls, u.chars into v_calls, v_chars;

  return v_calls <= p_max_calls and v_chars <= p_max_chars;
end;
$$;

revoke all on function public.pocket_consume(int, int, bigint) from public, anon, authenticated;
grant execute on function public.pocket_consume(int, int, bigint) to service_role;
