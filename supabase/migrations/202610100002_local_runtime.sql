create extension if not exists pgmq;
create extension if not exists pg_cron with schema pg_catalog;

-- Server-only deletion supports scoped cleanup of isolated local fixtures.
grant delete on public.content_studio_workspaces to service_role;

create or replace function public.studio_runtime_health()
returns jsonb
language sql
security definer
set search_path = public, pg_catalog
as $$
  select jsonb_build_object(
    'database', true,
    'pgmq', exists(select 1 from pg_extension where extname = 'pgmq'),
    'pg_cron', exists(select 1 from pg_extension where extname = 'pg_cron'),
    'workspaceCount', (select count(*) from public.content_studio_workspaces),
    'serverVersion', current_setting('server_version')
  );
$$;
revoke all on function public.studio_runtime_health() from public, anon, authenticated;
grant execute on function public.studio_runtime_health() to service_role;
