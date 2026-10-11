-- Additive contracts. Historic drafts, snapshots, job IDs and approval inputs stay unchanged.
alter table public.studio_assets add column if not exists storage_provider text not null default 'supabase' check(storage_provider in ('supabase','localfs'));
alter table public.studio_assets add column if not exists status text not null default 'finalized' check(status in ('pending','finalized'));
alter table public.studio_assets add column if not exists upload_id text;
alter table public.studio_assets add column if not exists localfs_key text;
alter table public.studio_assets drop constraint if exists studio_assets_object_key_key;
create unique index if not exists studio_assets_upload_identity on public.studio_assets(workspace_id,upload_id) where upload_id is not null;
alter table public.studio_operations alter column draft_id drop not null;
alter table public.studio_operations add column if not exists subject_kind text not null default 'article' check(subject_kind in ('article','video'));
alter table public.studio_operations add column if not exists subject_id uuid;
update public.studio_operations set subject_id=draft_id where subject_id is null;
alter table public.studio_videos alter column draft_id drop not null;
create table if not exists public.studio_video_projects (
  id uuid primary key, workspace_id uuid not null references public.content_studio_workspaces(id),
  version integer not null check(version>0),content jsonb not null,updated_at timestamptz not null default now()
);
alter table public.studio_video_projects enable row level security;
revoke all on public.studio_video_projects from anon,authenticated;
grant all on public.studio_video_projects to service_role;
create or replace function public.studio_put_video_project(p_workspace uuid,p_id uuid,p_expected_version integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare existing public.studio_video_projects%rowtype;
begin
  perform 1 from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  if p_content->>'id'<>p_id::text or (p_content->>'version')::integer<>p_expected_version+1 then raise exception 'Invalid video identity or version'; end if;
  if p_expected_version=0 then
    insert into public.studio_video_projects(id,workspace_id,version,content) values(p_id,p_workspace,1,p_content);
    return p_content;
  end if;
  select * into existing from public.studio_video_projects where id=p_id and workspace_id=p_workspace for update;
  if not found or existing.version<>p_expected_version then raise exception 'Video project changed; refresh and retry'; end if;
  update public.studio_video_projects set content=p_content,version=p_expected_version+1,updated_at=now() where id=p_id;
  return p_content;
end $$;
revoke all on function public.studio_put_video_project(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_put_video_project(uuid,uuid,integer,jsonb) to service_role;
create or replace function public.studio_create_subject_operation(p_workspace uuid,p_id uuid,p_subject uuid,p_kind text,p_input jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare existing uuid;
begin
  perform 1 from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  if not exists(select 1 from public.studio_video_projects where id=p_subject and workspace_id=p_workspace) then raise exception 'Video project not found'; end if;
  select id into existing from public.studio_operations where workspace_id=p_workspace and subject_kind='video' and subject_id=p_subject and kind=p_kind and status in ('queued','running') and input=p_input limit 1;
  if existing is not null then return existing; end if;
  insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input) values(p_id,p_workspace,null,'video',p_subject,p_kind,p_input);
  perform public.studio_enqueue_work(p_workspace,'studio_operation',p_id);
  return p_id;
end $$;
revoke all on function public.studio_create_subject_operation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_create_subject_operation(uuid,uuid,uuid,text,jsonb) to service_role;
