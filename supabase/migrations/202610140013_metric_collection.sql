create table public.studio_metric_polls (
 workspace_id uuid not null references public.content_studio_workspaces(id),job_id uuid not null,enabled boolean not null default false,
 started_at timestamptz not null default now(),deadline timestamptz not null default now()+interval '16 hours',next_at timestamptz not null default now()+interval '1 minute',blocked_reason text,
 primary key(workspace_id,job_id)
);
create table public.studio_metric_attempts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.content_studio_workspaces(id),job_id uuid not null,slot bigint not null,
 operation_id uuid not null unique,status text not null default 'queued' check(status in ('queued','succeeded','failed','cancelled')),error text,created_at timestamptz not null default now(),finished_at timestamptz,
 unique(workspace_id,job_id,slot)
);
create table public.studio_metric_observations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.content_studio_workspaces(id),job_id uuid not null,attempt_id uuid not null unique references public.studio_metric_attempts(id),
 "values" jsonb not null,source text not null check(source in ('official_api','browser_readback','fixture')),definition text not null,adapter_version text not null,collected_at timestamptz not null default now(),anomaly text
);
do $$declare n text;begin for n in select unnest(array['studio_metric_polls','studio_metric_attempts','studio_metric_observations']) loop execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant all on public.%I to service_role',n);end loop;end $$;
alter table public.studio_operations drop constraint studio_operations_kind_check;
alter table public.studio_operations add constraint studio_operations_kind_check check(kind in ('sync','refine','video_script','video_render','publish','delivery_recovery','collect_metrics'));
create function public.studio_configure_metric_poll(p_workspace uuid,p_job uuid,p_enabled boolean,p_new_window boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare job jsonb; item public.studio_metric_polls%rowtype;
begin
 select value into job from public.content_studio_workspaces w,jsonb_array_elements(w.state->'jobs') value where w.id=p_workspace and value->>'id'=p_job::text;
 if job is null or job->>'status' not in ('published','delivered') or job->>'remoteId' is null or job->>'deliveryAction'='save_draft' then raise exception 'Confirmed work required';end if;
 insert into public.studio_metric_polls(workspace_id,job_id) values(p_workspace,p_job) on conflict do nothing;
 select * into item from public.studio_metric_polls where workspace_id=p_workspace and job_id=p_job for update;
 if p_new_window then update public.studio_metric_polls set started_at=now(),deadline=now()+interval '16 hours',next_at=now()+interval '1 minute',blocked_reason=null where workspace_id=p_workspace and job_id=p_job;
 elsif p_enabled and item.deadline<=now() then raise exception 'Window expired; request an explicit new window'; end if;
 update public.studio_metric_polls set enabled=p_enabled,blocked_reason=case when p_enabled then null else blocked_reason end where workspace_id=p_workspace and job_id=p_job returning * into item;
 return to_jsonb(item);
end $$;
create function public.studio_queue_metric_collection(p_workspace uuid,p_job uuid,p_manual boolean default false)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare job jsonb; poll public.studio_metric_polls%rowtype; attempt uuid:=gen_random_uuid();operation uuid:=gen_random_uuid();slot_value bigint;
begin
 select value into job from public.content_studio_workspaces w,jsonb_array_elements(w.state->'jobs') value where w.id=p_workspace and value->>'id'=p_job::text;
 if job is null or job->>'status' not in ('published','delivered') or job->>'remoteId' is null or job->>'deliveryAction'='save_draft' then raise exception 'Confirmed work required';end if;
 insert into public.studio_metric_polls(workspace_id,job_id) values(p_workspace,p_job) on conflict do nothing;
 select * into poll from public.studio_metric_polls where workspace_id=p_workspace and job_id=p_job for update;
 if poll.deadline<=now() or not p_manual and (not poll.enabled or poll.next_at>now()) then raise exception 'Metric slot is inactive or expired';end if;
 -- Real wall-clock ten-minute slots deduplicate manual and scheduled requests, including explicit new windows.
 slot_value:=floor(extract(epoch from now())/600)::bigint;
 select operation_id into operation from public.studio_metric_attempts where workspace_id=p_workspace and job_id=p_job and slot=slot_value;
 if found then return operation;end if;
 operation:=gen_random_uuid();
 insert into public.studio_metric_attempts(id,workspace_id,job_id,slot,operation_id) values(attempt,p_workspace,p_job,slot_value,operation);
 insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input)
 values(operation,p_workspace,(job->>'draftId')::uuid,coalesce(job->'subject'->>'kind','article'),coalesce((job->'subject'->>'id')::uuid,(job->>'draftId')::uuid),'collect_metrics',jsonb_build_object('jobId',p_job,'attemptId',attempt));
 perform public.studio_enqueue_work(p_workspace,'studio_operation',operation);
 update public.studio_metric_polls set next_at=now()+interval '10 minutes' where workspace_id=p_workspace and job_id=p_job;
 return operation;
end $$;
create function public.studio_finish_metric_attempt(p_workspace uuid,p_attempt uuid,p_operation uuid,p_owner uuid,p_observation jsonb,p_error text,p_delay_seconds integer)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
declare attempt public.studio_metric_attempts%rowtype; previous jsonb; metric_values jsonb; anomaly text:=null; name text; item jsonb;
begin
 perform 1 from public.studio_operations where id=p_operation and workspace_id=p_workspace and kind='collect_metrics' and status='running' and owner_token=p_owner and lease_until>now() for update;
 if not found then return false;end if;
 select * into attempt from public.studio_metric_attempts where id=p_attempt and workspace_id=p_workspace and operation_id=p_operation for update;
 if not found or attempt.status<>'queued' then return false;end if;
 if p_error is null then
  if p_observation is null or p_observation->>'source' not in ('official_api','browser_readback','fixture') then raise exception 'Metric evidence required';end if;
  metric_values:='{}'::jsonb;
  for name in select unnest(array['views','likes','comments','shares','favorites','clicks']) loop
   item:=p_observation->name;
   if item is null or (jsonb_typeof(item)<>'null' and (jsonb_typeof(item)<>'number' or (item::text)::numeric<0 or trunc((item::text)::numeric)<>(item::text)::numeric)) then raise exception 'Invalid metric value';end if;
   metric_values:=metric_values||jsonb_build_object(name,item);
  end loop;
  if not exists(select 1 from jsonb_each(metric_values) where jsonb_typeof(value)='number') then raise exception 'Missing metrics are not zero';end if;
  select "values" into previous from public.studio_metric_observations where workspace_id=p_workspace and job_id=attempt.job_id order by collected_at desc limit 1;
  for name in select unnest(array['views','likes','comments','shares','favorites','clicks']) loop
   if jsonb_typeof(previous->name)='number' and jsonb_typeof(metric_values->name)='number' and (metric_values->>name)::numeric<(previous->>name)::numeric then anomaly:='COUNT_DECREASED';end if;
  end loop;
  insert into public.studio_metric_observations(workspace_id,job_id,attempt_id,"values",source,definition,adapter_version,anomaly) values(p_workspace,attempt.job_id,p_attempt,metric_values,p_observation->>'source',left(p_observation->>'definition',300),left(p_observation->>'adapterVersion',80),anomaly);
 end if;
 update public.studio_metric_attempts set status=case when p_error is null then 'succeeded' else 'failed' end,error=p_error,finished_at=now() where id=p_attempt;
 update public.studio_metric_polls set next_at=greatest(next_at,now()+make_interval(secs=>greatest(60,least(p_delay_seconds,57600)))),enabled=case when p_error='AUTH_REQUIRED' then false else enabled end,blocked_reason=p_error where workspace_id=p_workspace and job_id=attempt.job_id;
 return true;
end $$;
create function public.studio_dispatch_metric_polls(p_workspace uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare item record;count integer:=0;
begin
 update public.studio_metric_polls set enabled=false,blocked_reason='WINDOW_EXPIRED' where enabled and deadline<=now() and (p_workspace is null or workspace_id=p_workspace);
 for item in select p.* from public.studio_metric_polls p where enabled and next_at<=now() and deadline>now() and (p_workspace is null or workspace_id=p_workspace) order by next_at for update skip locked limit 50 loop
  begin perform public.studio_queue_metric_collection(item.workspace_id,item.job_id,false);count:=count+1;exception when others then update public.studio_metric_polls set enabled=false,blocked_reason='WORK_UNAVAILABLE' where workspace_id=item.workspace_id and job_id=item.job_id;end;
 end loop;
 return count;
end $$;
alter function public.studio_dispatch_due_tasks(uuid) rename to studio_dispatch_content_tasks;
create function public.studio_dispatch_due_tasks(p_workspace uuid default null) returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
begin return public.studio_dispatch_content_tasks(p_workspace)+public.studio_dispatch_metric_polls(p_workspace);end $$;
revoke all on function public.studio_configure_metric_poll(uuid,uuid,boolean,boolean),public.studio_queue_metric_collection(uuid,uuid,boolean),public.studio_finish_metric_attempt(uuid,uuid,uuid,uuid,jsonb,text,integer),public.studio_dispatch_metric_polls(uuid),public.studio_dispatch_due_tasks(uuid) from public,anon,authenticated;
grant execute on function public.studio_configure_metric_poll(uuid,uuid,boolean,boolean),public.studio_queue_metric_collection(uuid,uuid,boolean),public.studio_finish_metric_attempt(uuid,uuid,uuid,uuid,jsonb,text,integer),public.studio_dispatch_metric_polls(uuid),public.studio_dispatch_due_tasks(uuid) to service_role;
-- Extend the existing role queue without introducing another queue engine or scheduler.
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
        p_role='delivery' and op.kind in ('publish','delivery_recovery','collect_metrics'))))
    order by q.msg_id for update of q skip locked limit 1;
  if not found then return null; end if;
  update pgmq.q_studio_jobs set read_ct=read_ct+1,vt=now()+interval '120 seconds' where msg_id=message.msg_id;
  insert into public.studio_queue_leases(msg_id,token,workspace_id,expires_at) values(message.msg_id,owner_token,p_workspace,now()+interval '120 seconds')
    on conflict(msg_id) do update set token=excluded.token,workspace_id=excluded.workspace_id,expires_at=excluded.expires_at;
  return jsonb_build_object('msgId',message.msg_id,'token',owner_token,'message',message.message,'attempt',message.read_ct+1);
end $$;
notify pgrst,'reload schema';
