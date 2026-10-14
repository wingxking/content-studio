-- Run on an isolated Docker Supabase after migration 017. All fixtures roll back.
begin;
do $$
declare workspace uuid:=gen_random_uuid(); fixture jsonb; count_before bigint;
begin
  fixture:=jsonb_build_object('id',gen_random_uuid(),'status','queued','provider','postiz','platform','reddit','providerPostId','fixture-accepted-id','verificationCheck',jsonb_build_object('nextAt',now()-interval '1 minute','deadline',now()+interval '24 hours','attempt',0));
  insert into public.content_studio_workspaces(id,state) values(workspace,jsonb_build_object('version',1,'paused',false,'drafts','[]'::jsonb,'accounts','[]'::jsonb,'jobs',jsonb_build_array(fixture)));
  select count(*) into count_before from cron.job;
  perform public.studio_dispatch_content_tasks(workspace);
  if (select count(*) from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text and message->>'type'='legacy_publish')<>1 then raise exception 'Accepted due Postiz readback must wake the existing delivery tick'; end if;
  perform public.studio_dispatch_content_tasks(workspace);
  if (select count(*) from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text)<>1 then raise exception 'Delivery tick must remain deduplicated'; end if;
  delete from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text;
  update public.content_studio_workspaces set state=jsonb_set(state,'{paused}','true'::jsonb) where id=workspace;
  perform public.studio_dispatch_content_tasks(workspace);
  if exists(select 1 from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text) then raise exception 'Paused restores must not start readback'; end if;
  update public.content_studio_workspaces set state=jsonb_set(jsonb_set(state,'{paused}','false'::jsonb),'{jobs}',jsonb_build_array(fixture-'verificationCheck')) where id=workspace;
  perform public.studio_dispatch_content_tasks(workspace);
  if exists(select 1 from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text) then raise exception 'Historical accepted IDs must not start readback without explicit metadata'; end if;
  update public.content_studio_workspaces set state=jsonb_set(state,'{jobs}',jsonb_build_array(fixture||jsonb_build_object('status','needs_reconciliation'),fixture||jsonb_build_object('deliveryAction','save_draft'),fixture-'providerPostId')) where id=workspace;
  perform public.studio_dispatch_content_tasks(workspace);
  if exists(select 1 from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text) then raise exception 'Unknown, draft or ID-free jobs must not start readback'; end if;
  update public.content_studio_workspaces set state=jsonb_set(state,'{jobs}',jsonb_build_array(fixture||jsonb_build_object('provider','native','platform','youtube','status','delivered','remoteId','AbCdeF123_-'))) where id=workspace;
  perform public.studio_dispatch_content_tasks(workspace);
  if (select count(*) from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text)<>1 then raise exception 'Accepted YouTube ID must wake read-only verification'; end if;
  if (select count(*) from cron.job)<>count_before then raise exception 'Readback must not add a cron schedule'; end if;
end $$;
rollback;
