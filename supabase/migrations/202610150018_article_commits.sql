-- Keep the existing workspace authority; atomically record immutable revisions and export work.
create table public.studio_article_commands (
  workspace_id uuid not null references public.content_studio_workspaces(id),
  command_id uuid not null,
  draft_id uuid not null,
  revision integer not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key(workspace_id,command_id)
);
alter table public.studio_article_commands enable row level security;
revoke all on public.studio_article_commands from public,anon,authenticated;
grant all on public.studio_article_commands to service_role;
alter table public.studio_operations drop constraint studio_operations_kind_check;
alter table public.studio_operations add constraint studio_operations_kind_check
 check(kind in ('sync','refine','video_script','video_render','publish','delivery_recovery','collect_metrics','article_export'));

create function public.studio_record_article_revision() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare draft jsonb; previous jsonb; stored jsonb; operation uuid;
begin
  for draft in select value from jsonb_array_elements(coalesce(new.state->'drafts','[]'::jsonb)) loop
    select value into previous from jsonb_array_elements(coalesce(old.state->'drafts','[]'::jsonb)) where value->>'id'=draft->>'id';
    if previous is not null and previous->'revision'=draft->'revision' then continue; end if;
    if previous is not null then
      insert into public.studio_revisions(draft_id,workspace_id,revision,content)
      values((previous->>'id')::uuid,new.id,(previous->>'revision')::integer,previous) on conflict(draft_id,revision) do nothing;
    end if;
    select content into stored from public.studio_revisions where draft_id=(draft->>'id')::uuid and revision=(draft->>'revision')::integer;
    if stored is not null and (stored-'approvedHash') is distinct from (draft-'approvedHash') then raise exception 'Immutable article revision conflict'; end if;
    insert into public.studio_revisions(draft_id,workspace_id,revision,content)
    values((draft->>'id')::uuid,new.id,(draft->>'revision')::integer,draft) on conflict(draft_id,revision) do nothing;
    operation:=gen_random_uuid();
    insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input)
    values(operation,new.id,(draft->>'id')::uuid,'article',(draft->>'id')::uuid,'article_export',jsonb_build_object('expectedRevision',(draft->>'revision')::integer,'exporterVersion',1));
    perform public.studio_enqueue_work(new.id,'studio_operation',operation);
  end loop;
  return new;
end $$;
create trigger studio_article_revision_committed after update of state on public.content_studio_workspaces
for each row execute function public.studio_record_article_revision();

create function public.studio_commit_article(p_workspace uuid,p_command uuid,p_expected_revision integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare ws public.content_studio_workspaces%rowtype; existing jsonb; saved jsonb; ordinal integer; prior public.studio_article_commands%rowtype;
 fingerprint text:=md5((p_content-'createdAt'-'approvedHash')::text); article uuid:=(p_content->>'id')::uuid;
begin
  select * into ws from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  select * into prior from public.studio_article_commands where workspace_id=p_workspace and command_id=p_command;
  if found then
    if prior.fingerprint<>fingerprint then raise exception 'Command ID already used for different article content'; end if;
    select content into saved from public.studio_revisions where workspace_id=p_workspace and draft_id=prior.draft_id and revision=prior.revision;
    return saved;
  end if;
  select value,position::integer-1 into existing,ordinal from jsonb_array_elements(ws.state->'drafts') with ordinality as item(value,position) where value->>'id'=article::text;
  if p_expected_revision=0 and existing is not null then return existing; end if;
  if coalesce((existing->>'revision')::integer,0)<>p_expected_revision then raise exception 'Draft revision changed; refresh and review'; end if;
  if p_content->>'revision' is null or (p_content->>'revision')::integer<>p_expected_revision+1 then raise exception 'Invalid article revision'; end if;
  if exists(select 1 from jsonb_array_elements(ws.state->'jobs') job where job->>'draftId'=article::text and job->>'status'='submitting') then raise exception 'Reconcile the active submission before editing'; end if;
  saved:=p_content;
  update public.content_studio_workspaces set state=case when existing is null then jsonb_set(state,'{drafts}',(state->'drafts')||jsonb_build_array(saved)) else jsonb_set(state,array['drafts',ordinal::text],saved) end,revision=revision+1,updated_at=now() where id=p_workspace;
  if saved->>'adaptationStatus'='pending' then
    perform public.studio_create_operation(p_workspace,gen_random_uuid(),article,'sync',jsonb_build_object('expectedRevision',(saved->>'revision')::integer,'model',saved->>'generationModel'));
  end if;
  insert into public.studio_article_commands(workspace_id,command_id,draft_id,revision,fingerprint) values(p_workspace,p_command,article,(saved->>'revision')::integer,fingerprint);
  return saved;
end $$;
revoke all on function public.studio_commit_article(uuid,uuid,integer,jsonb),public.studio_record_article_revision() from public,anon,authenticated;
grant execute on function public.studio_commit_article(uuid,uuid,integer,jsonb) to service_role;

-- The existing article worker owns exports; no second queue or timer is introduced.
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
        p_role='article' and op.subject_kind='article' and op.kind in ('sync','refine','article_export') or
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
