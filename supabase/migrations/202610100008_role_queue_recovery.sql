-- pgmq remains the sole execution engine; pg_cron remains the sole business scheduler.
create table if not exists public.studio_dead_letters(id bigint primary key,workspace_id uuid not null,message jsonb not null,attempts integer not null,error text not null,failed_at timestamptz not null default now());
alter table public.studio_dead_letters enable row level security;
revoke all on public.studio_dead_letters from anon,authenticated;
grant all on public.studio_dead_letters to service_role;
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
        p_role='delivery' and op.kind='publish')))
    order by q.msg_id for update of q skip locked limit 1;
  if not found then return null; end if;
  update pgmq.q_studio_jobs set read_ct=read_ct+1,vt=now()+interval '120 seconds' where msg_id=message.msg_id;
  insert into public.studio_queue_leases(msg_id,token,workspace_id,expires_at) values(message.msg_id,owner_token,p_workspace,now()+interval '120 seconds')
    on conflict(msg_id) do update set token=excluded.token,workspace_id=excluded.workspace_id,expires_at=excluded.expires_at;
  return jsonb_build_object('msgId',message.msg_id,'token',owner_token,'message',message.message,'attempt',message.read_ct+1);
end $$;
create or replace function public.studio_fail_role_work(p_workspace uuid,p_msg bigint,p_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare lease public.studio_queue_leases%rowtype; message pgmq.q_studio_jobs%rowtype;
begin
  select * into lease from public.studio_queue_leases where msg_id=p_msg and workspace_id=p_workspace for update;
  if not found or lease.token<>p_token or lease.expires_at<now() then return false; end if;
  select * into message from pgmq.q_studio_jobs where msg_id=p_msg for update;
  if not found then return false; end if;
  if message.read_ct>=5 then
    insert into public.studio_dead_letters(id,workspace_id,message,attempts,error) values(p_msg,p_workspace,message.message,message.read_ct,left(p_error,2000)) on conflict(id) do nothing;
    if message.message->>'type'='studio_operation' then
      update public.studio_operations set status='failed',phase='Retry budget exhausted; operator action required',error=left(p_error,2000),owner_token=null,lease_until=null,updated_at=now()
      where id=(message.message->>'id')::uuid and workspace_id=p_workspace and status in ('queued','running');
    end if;
    perform pgmq.archive('studio_jobs',p_msg);
  else
    perform pgmq.set_vt('studio_jobs',p_msg,least(300,(power(2,message.read_ct)*5)::integer));
  end if;
  delete from public.studio_queue_leases where msg_id=p_msg;
  return true;
end $$;
revoke all on function public.studio_claim_role_work(uuid,text),public.studio_fail_role_work(uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.studio_claim_role_work(uuid,text),public.studio_fail_role_work(uuid,bigint,uuid,text) to service_role;

create or replace function public.studio_operation_diagnostics() returns jsonb language sql security definer set search_path=public,pg_catalog as $$
select jsonb_build_object('engine','pgmq','scheduler','pg_cron','operations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'subject',subject_kind,'subjectId',coalesce(subject_id,draft_id),'stage',phase,'status',status,'heartbeat',updated_at,'leaseUntil',lease_until,'error',error)) from (select * from public.studio_operations order by updated_at desc limit 50) recent),'[]'::jsonb),'deadLetters',coalesce((select jsonb_agg(jsonb_build_object('id',id,'attempts',attempts,'error',error,'failedAt',failed_at)) from (select * from public.studio_dead_letters order by failed_at desc limit 20) recent),'[]'::jsonb));
$$;
revoke all on function public.studio_operation_diagnostics() from public,anon,authenticated;
grant execute on function public.studio_operation_diagnostics() to service_role;
