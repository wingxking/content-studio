-- Optional Supabase persistence for the single-operator stage-one workspace.
create table if not exists public.content_studio_workspaces (
  id uuid primary key,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
alter table public.content_studio_workspaces enable row level security;
revoke all on public.content_studio_workspaces from anon, authenticated;
grant select, insert, update on public.content_studio_workspaces to service_role;
-- No browser-facing policy. The secret key stays in the local server environment.
