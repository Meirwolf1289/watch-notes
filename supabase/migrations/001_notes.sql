-- Pocket Watch: notes table + private audio bucket

create table if not exists public.notes (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  recorded_at   timestamptz,
  audio_path    text,            -- null for text-only notes (Shortcut / version A)
  transcript    text not null,
  title         text,
  summary       text,
  action_items  jsonb not null default '[]'::jsonb,
  people        text[] not null default '{}'
);

create index if not exists notes_created_at_idx on public.notes (created_at desc);

-- RLS on, no policies: only the Edge Function (service role) can read/write.
alter table public.notes enable row level security;

-- Private bucket for the raw audio
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;
