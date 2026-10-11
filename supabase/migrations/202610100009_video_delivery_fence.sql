-- Serialize project edits with aggregate publication CAS and freeze active approvals.
create or replace function public.studio_put_video_project(p_workspace uuid,p_id uuid,p_expected_version integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare existing public.studio_video_projects%rowtype; workspace_state jsonb;
begin
  select state into workspace_state from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  if p_content->>'id'<>p_id::text or (p_content->>'version')::integer<>p_expected_version+1 then raise exception 'Invalid video identity or version'; end if;
  if p_expected_version=0 then
    insert into public.studio_video_projects(id,workspace_id,version,content) values(p_id,p_workspace,1,p_content);
    return p_content;
  end if;
  select * into existing from public.studio_video_projects where id=p_id and workspace_id=p_workspace for update;
  if not found or existing.version<>p_expected_version then raise exception 'Video project changed; refresh and retry'; end if;
  if (existing.content->'revision' is distinct from p_content->'revision' or existing.content->'deliveryApproval' is distinct from p_content->'deliveryApproval' or existing.content->'approval' is distinct from p_content->'approval') and exists (
    select 1 from jsonb_array_elements(workspace_state->'jobs') as job where job->'subject'->>'kind'='video' and job->'subject'->>'id'=p_id::text and job->>'status' in ('submitting','queued','needs_reconciliation')
  ) then raise exception 'Reconcile the active video delivery before changing its approved revision'; end if;
  update public.content_studio_workspaces set revision=revision+1,updated_at=now() where id=p_workspace;
  update public.studio_video_projects set content=p_content,version=p_expected_version+1,updated_at=now() where id=p_id;
  return p_content;
end $$;
revoke all on function public.studio_put_video_project(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_put_video_project(uuid,uuid,integer,jsonb) to service_role;
