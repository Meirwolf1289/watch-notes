-- Which notes were already copied to Apple Notes by the "Pocket Notes Sync" shortcut.
alter table public.notes add column if not exists synced_to_notes_at timestamptz;
create index if not exists notes_unsynced_idx on public.notes (created_at) where synced_to_notes_at is null and status = 'ok';
-- Existing rows are test data: mark them synced so the first sync only imports NEW notes.
update public.notes set synced_to_notes_at = now() where synced_to_notes_at is null;
