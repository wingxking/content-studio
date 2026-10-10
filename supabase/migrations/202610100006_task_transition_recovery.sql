-- Preserve a new once occurrence while an older task snapshot still runs.
create or replace function public.studio_dispatch_due_tasks(p_workspace uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare task public.studio_tasks; slot_time timestamptz; dispatched integer:=0; workspace_row record;
begin
  for task in select * from public.studio_tasks where next_run_at<=now() and (p_workspace is null or workspace_id=p_workspace) and (config->>'enabled')::boolean order by next_run_at for update skip locked limit 50 loop
    slot_time:=case when task.config#>>'{frequency,type}'='once' then task.next_run_at else coalesce(public.studio_latest_task_slot(task.config,now()),task.next_run_at) end;
    if not exists(select 1 from public.studio_task_runs where task_id=task.id and status in('queued','researching','generating')) then
      perform public.studio_enqueue_task_run(task.workspace_id,task.id,'scheduled:'||to_char(slot_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      dispatched:=dispatched+1;
    elsif task.config#>>'{frequency,type}'='once' then
      continue;
    end if;
    if task.config#>>'{frequency,type}'='once' then update public.studio_tasks set next_run_at=null where id=task.id;
    else update public.studio_tasks set next_run_at=public.studio_next_task_time(task.config,now()) where id=task.id; end if;
  end loop;
  for workspace_row in select workspace.id from public.content_studio_workspaces workspace
    where (p_workspace is null or workspace.id=p_workspace) and coalesce((workspace.state->>'paused')::boolean,false)=false and exists(
      select 1 from jsonb_array_elements(workspace.state->'jobs') job
      where job->>'status'='scheduled' and (job->>'scheduledAt')::timestamptz<=now()
    ) loop
    if not exists(select 1 from pgmq.q_studio_jobs where message->>'type'='legacy_publish' and message->>'workspaceId'=workspace_row.id::text) then
      perform public.studio_enqueue_work(workspace_row.id,'legacy_publish',workspace_row.id);
    end if;
  end loop;
  return dispatched;
end $$;
revoke all on function public.studio_dispatch_due_tasks(uuid) from public,anon,authenticated;
grant execute on function public.studio_dispatch_due_tasks(uuid) to service_role;

-- A live commit finishes its stable draft linkage before cancellation is accepted.
-- An expired lease can cancel when no draft exists, or reconcile an already committed draft.
create or replace function public.studio_cancel_task_run(p_workspace uuid,p_run uuid)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_task_runs;
begin
  select * into row from public.studio_task_runs where id=p_run and workspace_id=p_workspace for update;
  if row.id is null then return row; end if;
  if row.status in('researching','generating') and row.phase='saving_draft' and row.lease_expires_at>=now() then
    raise exception 'The draft is being committed; wait for its saved result before cancelling';
  end if;
  if row.status in('queued','researching','generating','failed') and exists(
    select 1 from public.content_studio_workspaces workspace,
      lateral jsonb_array_elements(workspace.state->'drafts') draft
      where workspace.id=p_workspace and draft->>'id'=p_run::text
  ) then
    update public.studio_task_runs set status='succeeded',phase='completed',progress=100,draft_id=p_run,
      output_paths=null,error=null,lease_token=null,lease_expires_at=null,finished_at=now(),updated_at=now()
      where id=p_run and workspace_id=p_workspace returning * into row;
  elsif row.status in('queued','researching','generating') then
    update public.studio_task_runs set status='cancelled',phase='cancelled',lease_token=null,lease_expires_at=null,finished_at=now(),updated_at=now()
      where id=p_run and workspace_id=p_workspace returning * into row;
  end if;
  insert into public.studio_run_events(workspace_id,run_id,status,phase,progress) values(p_workspace,p_run,row.status,row.phase,row.progress);
  return row;
end $$;
revoke all on function public.studio_cancel_task_run(uuid,uuid) from public,anon,authenticated;
grant execute on function public.studio_cancel_task_run(uuid,uuid) to service_role;
