-- Additive JSON contract: no legacy video revisions, render hashes, files or receipts are rewritten.
-- Target changes and cancellation of their unsubmitted jobs share the existing workspace lock.
create or replace function public.studio_put_video_project(p_workspace uuid,p_id uuid,p_expected_version integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  existing public.studio_video_projects%rowtype;
  workspace_state jsonb; job jsonb; changed_jobs jsonb:='[]'::jsonb;
  old_target jsonb; new_target jsonb; old_render jsonb; new_render jsonb;
  old_revision jsonb; new_revision jsonb; target_id text; target_changed boolean;
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
  for job in select value from jsonb_array_elements(workspace_state->'jobs') loop
    if job->'subject'->>'kind'='video' and job->'subject'->>'id'=p_id::text then
      select value into old_revision from jsonb_array_elements(existing.content->'revisions') where value->>'number'=job->'snapshot'->'video'->>'revision';
      select value into new_revision from jsonb_array_elements(p_content->'revisions') where value->>'number'=job->'snapshot'->'video'->>'revision';
      select value into old_render from jsonb_array_elements(existing.content->'renders') where value->>'id'=job->'snapshot'->'video'->>'renderId';
      select value into new_render from jsonb_array_elements(p_content->'renders') where value->>'id'=job->'snapshot'->'video'->>'renderId';
      if old_revision is distinct from new_revision or old_render is distinct from new_render then
        raise exception 'A video delivery references this immutable revision and render';
      end if;
      target_id:=job->'snapshot'->'video'->>'targetId';
      if target_id is null then
        -- The virtual legacy target remains bound to its unmodified V1 approval.
        target_changed:=existing.content->'deliveryApproval' is distinct from p_content->'deliveryApproval';
      else
        select value into old_target from jsonb_array_elements(coalesce(existing.content->'targets','[]'::jsonb)) where value->>'id'=target_id;
        select value into new_target from jsonb_array_elements(coalesce(p_content->'targets','[]'::jsonb)) where value->>'id'=target_id;
        target_changed:=old_target is distinct from new_target;
      end if;
      if job->>'status' in ('submitting','queued','needs_reconciliation') and
        (existing.content->'revision' is distinct from p_content->'revision' or existing.content->'brief' is distinct from p_content->'brief' or target_changed) then
        raise exception 'Reconcile the active video target delivery before changing its approved revision';
      end if;
      -- No submission has begun. Retire only this target's old pending handoff/queue.
      -- Filesystem journal presence is checked by the application before entering this RPC.
      if target_changed and job->>'status' in ('scheduled','awaiting_operator','failed') and
        coalesce((job->>'attempts')::integer,0)=0 and nullif(job->>'remoteId','') is null and nullif(job->>'providerPostId','') is null then
        job:=job||jsonb_build_object('status','cancelled','error',null,'history',coalesce(job->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
          'at',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status','cancelled','message','Video target changed before submission; review its new version.')));
      end if;
    end if;
    changed_jobs:=changed_jobs||jsonb_build_array(job);
  end loop;
  workspace_state:=jsonb_set(workspace_state,'{jobs}',changed_jobs);
  update public.content_studio_workspaces set state=workspace_state,revision=revision+1,updated_at=now() where id=p_workspace;
  update public.studio_video_projects set content=p_content,version=p_expected_version+1,updated_at=now() where id=p_id;
  return p_content;
end $$;
revoke all on function public.studio_put_video_project(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_put_video_project(uuid,uuid,integer,jsonb) to service_role;
