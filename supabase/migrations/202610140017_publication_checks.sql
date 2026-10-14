-- Extend the existing pg_cron -> pgmq legacy_publish tick; no new schedule owner.
create or replace function public.studio_dispatch_content_tasks(p_workspace uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare task public.studio_tasks; slot_time timestamptz; dispatched integer:=0; workspace_row record;
begin
  for task in select * from public.studio_tasks where next_run_at<=now() and (p_workspace is null or workspace_id=p_workspace) and (config->>'enabled')::boolean order by next_run_at for update skip locked limit 50 loop
    slot_time:=case when task.config#>>'{frequency,type}'='once' then task.next_run_at else coalesce(public.studio_latest_task_slot(task.config,now()),task.next_run_at) end;
    if not exists(select 1 from public.studio_task_runs where task_id=task.id and status in('queued','researching','generating')) then
      perform public.studio_enqueue_task_run(task.workspace_id,task.id,'scheduled:'||to_char(slot_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      dispatched:=dispatched+1;
    elsif task.config#>>'{frequency,type}'='once' then continue;
    end if;
    if task.config#>>'{frequency,type}'='once' then update public.studio_tasks set next_run_at=null where id=task.id;
    else update public.studio_tasks set next_run_at=public.studio_next_task_time(task.config,now()) where id=task.id; end if;
  end loop;
  for workspace_row in select workspace.id from public.content_studio_workspaces workspace
    where (p_workspace is null or workspace.id=p_workspace) and coalesce((workspace.state->>'paused')::boolean,false)=false and exists(
      select 1 from jsonb_array_elements(workspace.state->'jobs') job where
      (job->>'status'='scheduled' and (job->>'scheduledAt')::timestamptz<=now()) or
      (job->>'deliveryAction' is null and job#>>'{verificationCheck,nextAt}' is not null and (job#>>'{verificationCheck,nextAt}')::timestamptz<=now() and (
        (job->>'provider'='postiz' and job->>'status'='queued' and nullif(job->>'providerPostId','') is not null) or
        (job->>'provider'='native' and job->>'platform'='youtube' and job->>'status' in('queued','delivered') and nullif(job->>'remoteId','') is not null)
      ))
    ) loop
    if not exists(select 1 from pgmq.q_studio_jobs where message->>'type'='legacy_publish' and message->>'workspaceId'=workspace_row.id::text) then
      perform public.studio_enqueue_work(workspace_row.id,'legacy_publish',workspace_row.id);
    end if;
  end loop;
  return dispatched;
end $$;
revoke all on function public.studio_dispatch_content_tasks(uuid) from public,anon,authenticated;
grant execute on function public.studio_dispatch_content_tasks(uuid) to service_role;
notify pgrst,'reload schema';
