create table if not exists public.studio_tasks (
  id uuid primary key,
  workspace_id uuid not null,
  config jsonb not null,
  config_version bigint not null default 1,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studio_tasks_due_idx on public.studio_tasks(next_run_at) where next_run_at is not null;
create index if not exists studio_tasks_workspace_idx on public.studio_tasks(workspace_id,created_at desc);

create table if not exists public.studio_task_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null references public.studio_tasks(id),
  slot text not null,
  task_snapshot jsonb not null,
  status text not null default 'queued' check(status in ('queued','researching','generating','succeeded','failed','cancelled')),
  phase text not null default 'queued',
  progress integer not null default 0 check(progress between 0 and 100),
  attempt integer not null default 0,
  error text,
  warnings jsonb not null default '[]',
  sources jsonb not null default '[]',
  questions jsonb not null default '[]' check(jsonb_array_length(questions) <= 20),
  master jsonb,
  variants jsonb not null default '[]',
  draft_id uuid,
  output_paths jsonb,
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,task_id,slot)
);
create index if not exists studio_runs_workspace_idx on public.studio_task_runs(workspace_id,created_at desc);
create table if not exists public.studio_run_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  run_id uuid not null references public.studio_task_runs(id),
  status text not null,
  phase text not null,
  progress integer not null,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists studio_run_events_run_idx on public.studio_run_events(run_id,id);
create table if not exists public.studio_queue_leases (
  msg_id bigint primary key,
  token uuid not null,
  workspace_id uuid not null,
  expires_at timestamptz not null
);

do $$ begin
  if not exists(select 1 from pgmq.meta where queue_name='studio_jobs') then perform pgmq.create('studio_jobs'); end if;
end $$;

create or replace function public.studio_next_task_time(p_config jsonb,p_after timestamptz)
returns timestamptz language plpgsql set search_path=public,pg_catalog as $$
declare
  zone text := p_config#>>'{frequency,timezone}';
  frequency text := p_config#>>'{frequency,type}';
  local_now timestamp := p_after at time zone zone;
  local_slot timestamp;
  candidate timestamptz;
  offset_day integer;
begin
  if frequency='once' then
    candidate := (p_config#>>'{frequency,onceAt}')::timestamptz;
    if candidate > p_after then return candidate; end if;
    return null;
  end if;
  for offset_day in 0..8 loop
    local_slot := (local_now::date+offset_day)+(p_config#>>'{frequency,time}')::time;
    if frequency='weekly' and not (p_config#>'{frequency,weekdays}') @> jsonb_build_array(extract(dow from local_slot)::integer) then continue; end if;
    candidate := local_slot at time zone zone;
    if (candidate at time zone zone) <> local_slot then continue; end if;
    if candidate>p_after then return candidate; end if;
  end loop;
  return null;
end $$;

create or replace function public.studio_latest_task_slot(p_config jsonb,p_through timestamptz)
returns timestamptz language plpgsql set search_path=public,pg_catalog as $$
declare
  zone text := p_config#>>'{frequency,timezone}';
  frequency text := p_config#>>'{frequency,type}';
  local_now timestamp := p_through at time zone zone;
  local_slot timestamp;
  candidate timestamptz;
  offset_day integer;
begin
  if frequency='once' then return (p_config#>>'{frequency,onceAt}')::timestamptz; end if;
  for offset_day in 0..8 loop
    local_slot := (local_now::date-offset_day)+(p_config#>>'{frequency,time}')::time;
    if frequency='weekly' and not (p_config#>'{frequency,weekdays}') @> jsonb_build_array(extract(dow from local_slot)::integer) then continue; end if;
    candidate := local_slot at time zone zone;
    if (candidate at time zone zone) <> local_slot then continue; end if;
    if candidate<=p_through then return candidate; end if;
  end loop;
  return null;
end $$;

create or replace function public.studio_save_task(p_workspace uuid,p_id uuid,p_config jsonb)
returns public.studio_tasks language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_tasks; next_time timestamptz;
begin
  if (p_config->>'enabled')::boolean then
    if p_config#>>'{frequency,type}'='once' and p_config#>>'{frequency,onceAt}' is not null then next_time:=(p_config#>>'{frequency,onceAt}')::timestamptz;
    else next_time:=public.studio_next_task_time(p_config,clock_timestamp()); end if;
  end if;
  -- Saving an already consumed once task does not silently arm the same occurrence again.
  if p_config#>>'{frequency,type}'='once' and exists(select 1 from public.studio_tasks existing where existing.id=p_id and existing.workspace_id=p_workspace and existing.next_run_at is null and existing.config->'frequency'=p_config->'frequency') and exists(select 1 from public.studio_task_runs where task_id=p_id and workspace_id=p_workspace) then next_time:=null; end if;
  insert into public.studio_tasks(id,workspace_id,config,next_run_at) values(p_id,p_workspace,p_config,next_time)
    on conflict(id) do update set config=excluded.config,config_version=studio_tasks.config_version+1,next_run_at=excluded.next_run_at,updated_at=now()
    where studio_tasks.workspace_id=p_workspace returning * into row;
  if row.id is null then raise exception 'Task workspace mismatch'; end if;
  return row;
end $$;

create or replace function public.studio_enqueue_work(p_workspace uuid,p_type text,p_id uuid)
returns bigint language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
begin
  if p_type !~ '^[a-z][a-z0-9_]{0,49}$' then raise exception 'Invalid work type'; end if;
  return pgmq.send('studio_jobs',jsonb_build_object('type',p_type,'id',p_id,'workspaceId',p_workspace));
end $$;

create or replace function public.studio_enqueue_task_run(p_workspace uuid,p_task uuid,p_slot text)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare task public.studio_tasks; row public.studio_task_runs;
begin
  select * into task from public.studio_tasks where id=p_task and workspace_id=p_workspace for update;
  if task.id is null then raise exception 'Task not found'; end if;
  if p_slot like 'manual:%' then
    select * into row from public.studio_task_runs where workspace_id=p_workspace and task_id=p_task and status in('queued','researching','generating') order by created_at desc limit 1;
    if row.id is not null then return row; end if;
    if task.config#>>'{frequency,type}'='once' then update public.studio_tasks set next_run_at=null where id=task.id; end if;
  end if;
  insert into public.studio_task_runs(workspace_id,task_id,slot,task_snapshot)
    values(p_workspace,p_task,p_slot,task.config||jsonb_build_object('id',task.id,'createdAt',task.created_at,'updatedAt',task.updated_at,'nextRunAt',task.next_run_at))
    on conflict(workspace_id,task_id,slot) do nothing returning * into row;
  if row.id is null then select * into row from public.studio_task_runs where workspace_id=p_workspace and task_id=p_task and slot=p_slot; return row; end if;
  perform public.studio_enqueue_work(p_workspace,'task_run',row.id);
  insert into public.studio_run_events(workspace_id,run_id,status,phase,progress) values(p_workspace,row.id,row.status,row.phase,row.progress);
  return row;
end $$;

create or replace function public.studio_dispatch_due_tasks(p_workspace uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare task public.studio_tasks; slot_time timestamptz; dispatched integer:=0; workspace_row record;
begin
  for task in select * from public.studio_tasks where next_run_at<=now() and (p_workspace is null or workspace_id=p_workspace) and (config->>'enabled')::boolean order by next_run_at for update skip locked limit 50 loop
    slot_time:=case when task.config#>>'{frequency,type}'='once' then task.next_run_at else coalesce(public.studio_latest_task_slot(task.config,now()),task.next_run_at) end;
    if not exists(select 1 from public.studio_task_runs where task_id=task.id and status in('queued','researching','generating')) then
      perform public.studio_enqueue_task_run(task.workspace_id,task.id,'scheduled:'||to_char(slot_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
      dispatched:=dispatched+1;
    end if;
    if task.config#>>'{frequency,type}'='once' then update public.studio_tasks set next_run_at=null where id=task.id;
    else update public.studio_tasks set next_run_at=public.studio_next_task_time(task.config,now()) where id=task.id; end if;
  end loop;
  -- The same pg_cron tick owns legacy publication due checks; Node only consumes deliveries.
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

create or replace function public.studio_claim_work(p_workspace uuid)
returns jsonb language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare message record; owner_token uuid:=gen_random_uuid(); iteration integer;
begin
  for iteration in 1..100 loop
    select * into message from pgmq.read('studio_jobs',120,1);
    if not found then return null; end if;
    if message.message->>'workspaceId'<>p_workspace::text then
      perform pgmq.set_vt('studio_jobs',message.msg_id,1); continue;
    end if;
    insert into public.studio_queue_leases(msg_id,token,workspace_id,expires_at) values(message.msg_id,owner_token,p_workspace,now()+interval '120 seconds')
      on conflict(msg_id) do update set token=excluded.token,expires_at=excluded.expires_at,workspace_id=excluded.workspace_id;
    return jsonb_build_object('msgId',message.msg_id,'token',owner_token,'message',message.message);
  end loop;
  return null;
end $$;

create or replace function public.studio_renew_work(p_workspace uuid,p_msg bigint,p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare row public.studio_queue_leases;
begin
  select * into row from public.studio_queue_leases where msg_id=p_msg and workspace_id=p_workspace for update;
  if row.token is distinct from p_token or row.expires_at<now() then return false; end if;
  perform pgmq.set_vt('studio_jobs',p_msg,120);
  update public.studio_queue_leases set expires_at=now()+interval '120 seconds' where msg_id=p_msg;
  update public.studio_task_runs set lease_expires_at=now()+interval '120 seconds' where lease_token=p_token and status in('researching','generating');
  return true;
end $$;

create or replace function public.studio_ack_work(p_workspace uuid,p_msg bigint,p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare row public.studio_queue_leases;
begin
  select * into row from public.studio_queue_leases where msg_id=p_msg and workspace_id=p_workspace for update;
  if row.token is distinct from p_token then return false; end if;
  perform pgmq.archive('studio_jobs',p_msg); delete from public.studio_queue_leases where msg_id=p_msg; return true;
end $$;

create or replace function public.studio_claim_task_run(p_workspace uuid,p_run uuid,p_token uuid)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_task_runs;
begin
  update public.studio_task_runs set status='researching',phase=case when jsonb_array_length(sources)>0 then 'resuming' else 'researching' end,
    attempt=attempt+1,lease_token=p_token,lease_expires_at=now()+interval '120 seconds',started_at=coalesce(started_at,now()),finished_at=null,error=null,updated_at=now()
    where id=p_run and workspace_id=p_workspace and (status='queued' or (status in('researching','generating') and lease_expires_at<now())) returning * into row;
  if row.id is not null then insert into public.studio_run_events(workspace_id,run_id,status,phase,progress) values(p_workspace,p_run,row.status,row.phase,row.progress); end if;
  return row;
end $$;

create or replace function public.studio_patch_task_run(p_workspace uuid,p_run uuid,p_token uuid,p_patch jsonb)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_task_runs;
begin
  update public.studio_task_runs set
    status=coalesce(p_patch->>'status',status),phase=coalesce(p_patch->>'phase',phase),progress=coalesce((p_patch->>'progress')::integer,progress),
    error=case when p_patch ? 'error' then p_patch->>'error' else error end,
    warnings=coalesce(p_patch->'warnings',warnings),
    sources=coalesce(p_patch->'sources',sources),questions=coalesce(p_patch->'questions',questions),
    master=case when p_patch ? 'master' then p_patch->'master' else master end,
    variants=coalesce(p_patch->'variants',variants),draft_id=coalesce((p_patch->>'draftId')::uuid,draft_id),
    output_paths=coalesce(p_patch->'outputPaths',output_paths),updated_at=now(),
    finished_at=case when p_patch->>'status' in('succeeded','failed','cancelled') then now() else finished_at end
    where id=p_run and workspace_id=p_workspace and lease_token=p_token and lease_expires_at>=now() and status in('researching','generating') returning * into row;
  if row.id is not null then insert into public.studio_run_events(workspace_id,run_id,status,phase,progress,message) values(p_workspace,p_run,row.status,row.phase,row.progress,row.error); end if;
  return row;
end $$;

create or replace function public.studio_cancel_task_run(p_workspace uuid,p_run uuid)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_task_runs;
begin
  update public.studio_task_runs set status='cancelled',phase='cancelled',lease_token=null,lease_expires_at=null,finished_at=now(),updated_at=now()
    where id=p_run and workspace_id=p_workspace and status in('queued','researching','generating') returning * into row;
  if row.id is null then select * into row from public.studio_task_runs where id=p_run and workspace_id=p_workspace; end if;
  if row.id is not null then insert into public.studio_run_events(workspace_id,run_id,status,phase,progress) values(p_workspace,p_run,row.status,row.phase,row.progress); end if;
  return row;
end $$;

create or replace function public.studio_retry_task_run(p_workspace uuid,p_run uuid)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare row public.studio_task_runs;
begin
  update public.studio_task_runs set status='queued',phase='retry_queued',error=null,lease_token=null,lease_expires_at=null,finished_at=null,updated_at=now()
    where id=p_run and workspace_id=p_workspace and status in('failed','cancelled') returning * into row;
  if row.id is null then raise exception 'Only failed or cancelled runs can be retried'; end if;
  perform public.studio_enqueue_work(p_workspace,'task_run',p_run);
  insert into public.studio_run_events(workspace_id,run_id,status,phase,progress) values(p_workspace,p_run,row.status,row.phase,row.progress);
  return row;
end $$;

alter table public.studio_tasks enable row level security;
alter table public.studio_task_runs enable row level security;
alter table public.studio_run_events enable row level security;
alter table public.studio_queue_leases enable row level security;
revoke all on public.studio_tasks,public.studio_task_runs,public.studio_run_events,public.studio_queue_leases from public,anon,authenticated;
grant select,insert,update,delete on public.studio_tasks,public.studio_task_runs,public.studio_run_events,public.studio_queue_leases to service_role;
grant usage,select on sequence public.studio_run_events_id_seq to service_role;
do $$ declare entry record; begin
  for entry in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname like 'studio_%' and proname in ('studio_save_task','studio_next_task_time','studio_latest_task_slot','studio_enqueue_work','studio_enqueue_task_run','studio_dispatch_due_tasks','studio_claim_work','studio_renew_work','studio_ack_work','studio_claim_task_run','studio_patch_task_run','studio_cancel_task_run','studio_retry_task_run') loop
    execute format('revoke all on function %s from public,anon,authenticated',entry.signature);
    execute format('grant execute on function %s to service_role',entry.signature);
  end loop;
end $$;
do $$ begin
  if not exists(select 1 from cron.job where jobname='content-studio-task-dispatcher') then
    perform cron.schedule('content-studio-task-dispatcher','* * * * *','select public.studio_dispatch_due_tasks()');
  end if;
end $$;
