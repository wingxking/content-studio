-- Discovery automation only creates reviewable content tasks. It never creates deliveries.
create table public.studio_discovery_promotions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  parent_run_id uuid not null references public.studio_task_runs(id),
  candidate_hash text not null check(candidate_hash ~ '^[a-f0-9]{32}$'),
  candidate_index integer not null check(candidate_index between 0 and 19),
  child_task_id uuid not null references public.studio_tasks(id),
  child_run_id uuid not null references public.studio_task_runs(id),
  created_at timestamptz not null default now(),
  unique(workspace_id,parent_run_id,candidate_hash),
  unique(workspace_id,child_task_id),
  unique(workspace_id,child_run_id)
);
create index studio_discovery_promotions_parent_idx on public.studio_discovery_promotions(workspace_id,parent_run_id);
alter table public.studio_discovery_promotions enable row level security;
revoke all on public.studio_discovery_promotions from public,anon,authenticated;
grant select,insert,update,delete on public.studio_discovery_promotions to service_role;

-- Match ECMAScript String.trim and UTF-16 slice used by taskFromQuestion labels.
create function public.studio_task_trim(p_value text)
returns text language sql immutable strict set search_path=pg_catalog as $$
  select btrim(p_value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
$$;
create function public.studio_task_label(p_value text,p_limit integer)
returns text language plpgsql immutable strict set search_path=public,pg_catalog as $$
declare result text:=''; character text; width integer; used integer:=0; index integer;
begin
  for index in 1..char_length(p_value) loop
    character:=substr(p_value,index,1); width:=case when ascii(character)>65535 then 2 else 1 end;
    if used+width>p_limit then exit; end if;
    result:=result||character; used:=used+width;
  end loop;
  return public.studio_task_trim(result);
end $$;

create function public.studio_promote_discovery_candidate(p_workspace uuid,p_parent_run uuid,p_candidate_index integer,p_config jsonb)
returns public.studio_discovery_promotions language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  parent public.studio_task_runs; question jsonb; source jsonb; platform jsonb; expected jsonb; selected_sources jsonb;
  max_drafts integer; candidate_hash_value text; relation public.studio_discovery_promotions;
  child_task public.studio_tasks; child_run public.studio_task_runs; child_id uuid:=gen_random_uuid();
begin
  -- Serializes concurrent repairs and binds authority to the completed immutable run, not an edited task.
  select * into parent from public.studio_task_runs where id=p_parent_run and workspace_id=p_workspace for update;
  if parent.id is null then raise exception 'Discovery parent run not found in workspace'; end if;
  if parent.status<>'succeeded' or parent.task_snapshot->>'kind'<>'discovery' then raise exception 'Only succeeded discovery runs can promote candidates'; end if;
  if parent.task_snapshot#>'{discoveryAutomation,enabled}' is distinct from 'true'::jsonb then raise exception 'Discovery automation is disabled'; end if;
  if parent.task_snapshot#>>'{discoveryAutomation,maxDrafts}' is null or parent.task_snapshot#>>'{discoveryAutomation,maxDrafts}' !~ '^[1-3]$' then raise exception 'Invalid discovery automation cap'; end if;
  max_drafts:=(parent.task_snapshot#>>'{discoveryAutomation,maxDrafts}')::integer;
  if p_candidate_index is null or p_candidate_index<0 or p_candidate_index>=max_drafts or p_candidate_index>=jsonb_array_length(parent.questions) then raise exception 'Candidate is outside the automated selection cap'; end if;
  question:=parent.questions->p_candidate_index;
  if question#>>'{assessment,status}' is distinct from 'allowed' or jsonb_typeof(question->'sourceUrls') is distinct from 'array' or jsonb_array_length(question->'sourceUrls')=0
    or jsonb_typeof(question->'platforms') is distinct from 'array' or jsonb_array_length(question->'platforms')=0 then raise exception 'Candidate is not a sourced allowed question'; end if;
  if length(public.studio_task_trim(question->>'question'))<3 or length(public.studio_task_trim(question->>'audienceNeed'))=0 or length(public.studio_task_trim(question->>'angle'))=0 then raise exception 'Candidate content is incomplete'; end if;
  for source in select value from jsonb_array_elements(question->'sourceUrls') loop
    if not exists(select 1 from jsonb_array_elements(parent.sources) verified where verified->'url'=source and length(public.studio_task_trim(verified->>'excerpt'))>0 and length(public.studio_task_trim(verified->>'title'))>0) then raise exception 'Candidate source is not verified by the parent run'; end if;
  end loop;
  for platform in select value from jsonb_array_elements(question->'platforms') loop
    if not (parent.task_snapshot->'platforms') @> jsonb_build_array(platform) then raise exception 'Candidate platform is outside the parent selection'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(question->'platforms'))<>(select count(distinct value) from jsonb_array_elements(question->'platforms')) then raise exception 'Candidate platforms must be unique'; end if;
  candidate_hash_value:=md5(question::text);
  select coalesce(jsonb_agg(verified order by ordinal),'[]'::jsonb) into selected_sources
    from jsonb_array_elements(parent.sources) with ordinality source_row(verified,ordinal)
    where question->'sourceUrls' @> jsonb_build_array(verified->>'url');
  expected:=jsonb_build_object(
    'title',public.studio_task_label(question->>'question',200),
    'prompt',public.studio_task_trim((question->>'question')||E'\n\nAudience need: '||(question->>'audienceNeed')||E'\nRequested angle: '||(question->>'angle')||E'\nResearch the verified sources in depth and generate reviewable master content and destination-specific versions.'),
    'audience',public.studio_task_label(question->>'audienceNeed',1000), 'angle',public.studio_task_trim(question->>'angle'),
    'model',parent.task_snapshot->'model','platforms',question->'platforms','sources',selected_sources,
    'assetIds',coalesce(parent.task_snapshot->'assetIds','[]'::jsonb),'knowledgeIds',coalesce(parent.task_snapshot->'knowledgeIds','[]'::jsonb),
    'kind','content','topicOrigin','trend','frequency',jsonb_build_object('type','once','time','09:00','timezone',parent.task_snapshot#>>'{frequency,timezone}'),
    'enabled',true,'discoveryAutomation',jsonb_build_object('enabled',false,'maxDrafts',1)
  );
  if p_config is distinct from expected then raise exception 'Child input does not match the frozen discovery candidate'; end if;
  select * into relation from public.studio_discovery_promotions where workspace_id=p_workspace and parent_run_id=p_parent_run and candidate_hash=candidate_hash_value;
  if relation.id is not null then return relation; end if;
  if (select count(*) from public.studio_discovery_promotions where workspace_id=p_workspace and parent_run_id=p_parent_run)>=max_drafts then raise exception 'Discovery promotion cap reached'; end if;
  insert into public.studio_tasks(id,workspace_id,config,next_run_at) values(child_id,p_workspace,expected,null) returning * into child_task;
  -- The occurrence has no next-run schedule. Existing pgmq remains the only job engine.
  child_run:=public.studio_enqueue_task_run(p_workspace,child_id,'discovery:'||p_parent_run::text||':'||candidate_hash_value);
  insert into public.studio_discovery_promotions(workspace_id,parent_run_id,candidate_hash,candidate_index,child_task_id,child_run_id)
    values(p_workspace,p_parent_run,candidate_hash_value,p_candidate_index,child_id,child_run.id) returning * into relation;
  return relation;
end $$;
revoke all on function public.studio_task_trim(text),public.studio_task_label(text,integer),public.studio_promote_discovery_candidate(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_task_trim(text),public.studio_task_label(text,integer),public.studio_promote_discovery_candidate(uuid,uuid,integer,jsonb) to service_role;
