alter table public.studio_task_runs add column guidance_version text;

create function public.studio_workspace_summary(p_workspace uuid) returns jsonb
language sql stable security definer set search_path=public,pg_catalog as $$
 select jsonb_build_object('paused',coalesce((state->>'paused')::boolean,true),'accounts',coalesce(state->'accounts','[]'::jsonb))
 from public.content_studio_workspaces where id=p_workspace;
$$;

create function public.studio_list_content(p_workspace uuid,p_kind text default null,p_platform text default null,p_task uuid default null,p_run uuid default null,p_status text default null,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 51,p_from timestamptz default null,p_to timestamptz default null)
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $$
 with workspace as (select state from public.content_studio_workspaces where id=p_workspace),
 articles as (
  select (d->>'id')::uuid id,'article'::text kind,d->>'title' title,(d->>'revision')::integer revision,
   (select coalesce(jsonb_agg(v->>'platform'),'[]'::jsonb) from jsonb_array_elements(d->'variants') v) platforms,
   (d->>'createdAt')::timestamptz created_at,(d->>'createdAt')::timestamptz updated_at,
   case when exists(select 1 from jsonb_array_elements(w.state->'jobs') j where j->>'draftId'=d->>'id' and j->>'status'='published') then 'published' else 'draft' end status,
   r.task_id,r.id run_id
  from workspace w cross join lateral jsonb_array_elements(w.state->'drafts') d
  left join lateral (select id,task_id from public.studio_task_runs where workspace_id=p_workspace and draft_id=(d->>'id')::uuid order by created_at desc limit 1) r on true
 ), videos as (
  select v.id,'video'::text kind,coalesce(v.content#>>'{brief,topic}','Video') title,(v.content->>'revision')::integer revision,
   case when jsonb_array_length(coalesce(v.content->'targets','[]'::jsonb))>0 then (select jsonb_agg(distinct t->>'platform') from jsonb_array_elements(v.content->'targets') t) else jsonb_build_array(v.content#>>'{brief,platform}') end platforms,
   (v.content->>'createdAt')::timestamptz created_at,v.updated_at,v.content->>'status' status,null::uuid task_id,null::uuid run_id
  from public.studio_video_projects v where v.workspace_id=p_workspace
 ), filtered as (
  select * from (select * from articles union all select * from videos) c
  where (p_kind is null or kind=p_kind) and (p_platform is null or platforms ? p_platform)
   and (p_task is null or task_id=p_task) and (p_status is null or status=p_status)
   and (p_run is null or run_id=p_run or exists(select 1 from public.studio_discovery_promotions pr where pr.workspace_id=p_workspace and pr.parent_run_id=p_run and pr.child_run_id=c.run_id))
   and (p_from is null or created_at>=p_from) and (p_to is null or created_at<=p_to)
   and (p_before is null or (created_at,id)<(p_before,p_before_id))
  order by created_at desc,id desc limit least(greatest(p_limit,1),101)
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'title',title,'revision',revision,'platforms',platforms,'createdAt',created_at,'updatedAt',updated_at,'status',status,'taskId',task_id,'runId',run_id) order by created_at desc,id desc),'[]'::jsonb) from filtered;
$$;

create or replace function public.studio_patch_task_run(p_workspace uuid,p_run uuid,p_token uuid,p_patch jsonb)
returns public.studio_task_runs language plpgsql security definer set search_path=public,pg_catalog as $$
declare result public.studio_task_runs;
begin
 update public.studio_task_runs set
  status=coalesce(p_patch->>'status',status),phase=coalesce(p_patch->>'phase',phase),progress=coalesce((p_patch->>'progress')::integer,progress),
  error=case when p_patch ? 'error' then p_patch->>'error' else error end,warnings=coalesce(p_patch->'warnings',warnings),
  sources=coalesce(p_patch->'sources',sources),questions=coalesce(p_patch->'questions',questions),
  master=case when p_patch ? 'master' then p_patch->'master' else master end,variants=coalesce(p_patch->'variants',variants),draft_id=coalesce((p_patch->>'draftId')::uuid,draft_id),
  output_paths=coalesce(p_patch->'outputPaths',output_paths),guidance_version=coalesce(guidance_version,p_patch->>'guidanceVersion'),updated_at=now(),
  finished_at=case when p_patch->>'status' in ('succeeded','failed','cancelled') then now() else finished_at end
 where id=p_run and workspace_id=p_workspace and lease_token=p_token and lease_expires_at>now() and status in ('researching','generating') returning * into result;
 if result.id is not null then insert into public.studio_run_events(workspace_id,run_id,status,phase,progress,message) values(p_workspace,p_run,result.status,result.phase,result.progress,result.error); end if;
 return result;
end $$;
revoke all on function public.studio_workspace_summary(uuid),public.studio_list_content(uuid,text,text,uuid,uuid,text,timestamptz,uuid,integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.studio_workspace_summary(uuid),public.studio_list_content(uuid,text,text,uuid,uuid,text,timestamptz,uuid,integer,timestamptz,timestamptz) to service_role;
notify pgrst,'reload schema';

-- A retry uses the command UUID as its task UUID and cannot silently change the saved configuration.
create function public.studio_create_task(p_workspace uuid,p_command uuid,p_config jsonb)
returns public.studio_tasks language plpgsql security definer set search_path=public,pg_catalog as $$
declare result public.studio_tasks;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||p_command::text,0));
 select * into result from public.studio_tasks where workspace_id=p_workspace and id=p_command;
 if result.id is not null then
  if result.config is distinct from p_config then raise exception 'Command ID already used for different task input'; end if;
  return result;
 end if;
 return public.studio_save_task(p_workspace,p_command,p_config);
end $$;
revoke all on function public.studio_create_task(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.studio_create_task(uuid,uuid,jsonb) to service_role;

create or replace function public.studio_promote_discovery_candidate(p_workspace uuid,p_parent_run uuid,p_candidate_index integer,p_config jsonb)
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
  expected:=expected || (parent.task_snapshot - array['id','createdAt','updatedAt','nextRunAt','title','prompt','audience','angle','model','platforms','sources','assetIds','knowledgeIds','kind','topicOrigin','frequency','enabled','discoveryAutomation']);
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

notify pgrst,'reload schema';
