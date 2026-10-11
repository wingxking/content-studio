-- Recovery actions execute exclusively in the delivery worker; video writes bind operation ownership.
alter table public.studio_operations drop constraint studio_operations_kind_check;
alter table public.studio_operations add constraint studio_operations_kind_check check(kind in ('sync','refine','video_script','video_render','publish','delivery_recovery'));
create or replace function public.studio_create_delivery_recovery(p_workspace uuid,p_id uuid,p_job uuid,p_action text)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare workspace_state jsonb; job jsonb; existing uuid;
begin
  select state into workspace_state from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  if p_action not in ('continue','reconcile','resume','dispatch','verify_channel') then raise exception 'Invalid recovery action'; end if;
  if p_action not in ('dispatch','verify_channel') then
    select value into job from jsonb_array_elements(workspace_state->'jobs') where value->>'id'=p_job::text;
    if job is null then raise exception 'Publication not found'; end if;
  end if;
  select id into existing from public.studio_operations where workspace_id=p_workspace and kind='delivery_recovery' and status in ('queued','running') and input->>'action'=p_action and (input->>'jobId') is not distinct from p_job::text limit 1;
  if existing is not null then return existing; end if;
  insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input)
  values(p_id,p_workspace,(job->>'draftId')::uuid,coalesce(job->'subject'->>'kind','article'),coalesce((job->'subject'->>'id')::uuid,(job->>'draftId')::uuid),'delivery_recovery',jsonb_build_object('jobId',p_job,'action',p_action));
  perform public.studio_enqueue_work(p_workspace,'studio_operation',p_id); return p_id;
end $$;
create or replace function public.studio_put_owned_video_project(p_workspace uuid,p_id uuid,p_expected_version integer,p_content jsonb,p_operation uuid,p_owner uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
begin
  perform 1 from public.content_studio_workspaces where id=p_workspace for update;
  perform 1 from public.studio_operations where id=p_operation and workspace_id=p_workspace and subject_kind='video' and subject_id=p_id and status='running' and owner_token=p_owner and lease_until>now() for update;
  if not found then raise exception 'Operation cancelled or ownership changed'; end if;
  return public.studio_put_video_project(p_workspace,p_id,p_expected_version,p_content);
end $$;
revoke all on function public.studio_create_delivery_recovery(uuid,uuid,uuid,text),public.studio_put_owned_video_project(uuid,uuid,integer,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.studio_create_delivery_recovery(uuid,uuid,uuid,text),public.studio_put_owned_video_project(uuid,uuid,integer,jsonb,uuid,uuid) to service_role;
create or replace function public.studio_claim_role_work(p_workspace uuid,p_role text)
returns jsonb language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare message pgmq.q_studio_jobs%rowtype; owner_token uuid:=gen_random_uuid();
begin
  if p_role not in ('article','video','delivery','all') then raise exception 'Unknown worker role'; end if;
  select q.* into message from pgmq.q_studio_jobs q
    where q.vt<=now() and q.message->>'workspaceId'=p_workspace::text and (
      p_role='all' or p_role='article' and q.message->>'type'='task_run' or
      p_role='delivery' and q.message->>'type'='legacy_publish' or
      q.message->>'type'='studio_operation' and exists(select 1 from public.studio_operations op where op.id=(q.message->>'id')::uuid and op.workspace_id=p_workspace and (
        p_role='article' and op.subject_kind='article' and op.kind in ('sync','refine') or
        p_role='video' and (op.kind in ('video_script','video_render') or op.subject_kind='video' and op.kind='refine') or
        p_role='delivery' and op.kind in ('publish','delivery_recovery'))))
    order by q.msg_id for update of q skip locked limit 1;
  if not found then return null; end if;
  update pgmq.q_studio_jobs set read_ct=read_ct+1,vt=now()+interval '120 seconds' where msg_id=message.msg_id;
  insert into public.studio_queue_leases(msg_id,token,workspace_id,expires_at) values(message.msg_id,owner_token,p_workspace,now()+interval '120 seconds')
    on conflict(msg_id) do update set token=excluded.token,workspace_id=excluded.workspace_id,expires_at=excluded.expires_at;
  return jsonb_build_object('msgId',message.msg_id,'token',owner_token,'message',message.message,'attempt',message.read_ct+1);
end $$;

create or replace function public.studio_cancel_operation(p_workspace uuid,p_operation uuid)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare operation_row public.studio_operations%rowtype; project_row public.studio_video_projects%rowtype; updated_content jsonb;
begin
  perform 1 from public.content_studio_workspaces where id=p_workspace for update;
  select * into operation_row from public.studio_operations where id=p_operation and workspace_id=p_workspace for update;
  if not found then raise exception 'Operation not found'; end if;
  if operation_row.kind in ('publish','delivery_recovery') and operation_row.status='running' then raise exception 'Publication may already be submitted; reconcile its platform result'; end if;
  if operation_row.kind='sync' and operation_row.status='running' and coalesce((operation_row.output->>'applying')::boolean,false) then
    raise exception 'Adapted content is being committed; wait for its saved result before editing';
  end if;
  if operation_row.status='succeeded' and (operation_row.kind<>'refine' or coalesce((operation_row.output->>'applied')::boolean,false)) then
    raise exception 'Completed work cannot be cancelled';
  end if;
  if operation_row.subject_kind='video' and operation_row.status='running' then
    select * into project_row from public.studio_video_projects where id=operation_row.subject_id and workspace_id=p_workspace for update;
    if found then
      if project_row.content->>'lastOperationId'=p_operation::text or exists(select 1 from jsonb_array_elements(project_row.content->'proposals') item where item->>'operationId'=p_operation::text) or exists(select 1 from jsonb_array_elements(project_row.content->'renders') item where item->>'operationId'=p_operation::text and item->>'status'='succeeded') then
        raise exception 'Completed video work cannot be cancelled; refresh its saved result';
      end if;
      if operation_row.kind='video_render' then
        select jsonb_set(project_row.content,'{renders}',coalesce(jsonb_agg(case when item->>'operationId'=p_operation::text and item->>'status'='running' then item||jsonb_build_object('status','cancelled','phase','Cancelled; completed stages retained','finishedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'error',null) else item end),'[]'::jsonb)) into updated_content from jsonb_array_elements(project_row.content->'renders') item;
        if updated_content<>project_row.content then
          updated_content:=updated_content||jsonb_build_object('version',project_row.version+1,'updatedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status',case when exists(select 1 from jsonb_array_elements(updated_content->'renders') item where item->>'status'='running') then 'rendering' when exists(select 1 from jsonb_array_elements(updated_content->'renders') item where item->>'status'='succeeded' and item->>'revision'=updated_content->>'revision') then 'ready' else 'editing' end);
          update public.studio_video_projects set content=updated_content,version=project_row.version+1,updated_at=now() where id=project_row.id and workspace_id=p_workspace;
        end if;
      end if;
    end if;
  end if;
  if operation_row.status in ('queued','running','succeeded') then
    update public.studio_operations set status='cancelled',phase='Cancelled by owner',updated_at=now() where id=p_operation;
  end if;
  return p_operation;
end $$;

create or replace function public.studio_scheduler_status() returns jsonb language sql security definer set search_path=public,pg_catalog as $$
select jsonb_build_object('ready',count(*)=2 and bool_and(active),'jobs',coalesce(jsonb_agg(jsonb_build_object('name',jobname,'enabled',active)),'[]'::jsonb)) from cron.job where jobname in ('content-studio-task-dispatcher','content-studio-adaptation-repair');
$$;
create or replace function public.studio_set_scheduler(p_enabled boolean) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare entry record;
begin
  for entry in select jobid from cron.job where jobname in ('content-studio-task-dispatcher','content-studio-adaptation-repair') loop perform cron.alter_job(entry.jobid,active:=p_enabled); end loop;
  return public.studio_scheduler_status();
end $$;
revoke all on function public.studio_scheduler_status(),public.studio_set_scheduler(boolean) from public,anon,authenticated;
grant execute on function public.studio_scheduler_status(),public.studio_set_scheduler(boolean) to service_role;
notify pgrst,'reload schema';
