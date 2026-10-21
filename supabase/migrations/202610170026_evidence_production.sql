-- Additive evidence production. Source bytes and model artifacts remain in LocalFS.
create extension if not exists vector with schema extensions;
create table public.studio_source_registry (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 id text not null, config jsonb not null, version integer not null default 1,
 health jsonb not null default '{}', next_poll_at timestamptz, updated_at timestamptz not null default now(),
 primary key(workspace_id,id)
);
create table public.studio_source_collections (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 source_id text not null, slot text not null, config jsonb not null, status text not null default 'queued' check(status in ('queued','succeeded','failed')),
 result_ref text, error text, created_at timestamptz not null default now(), finished_at timestamptz,
 unique(workspace_id,source_id,slot)
);
create table public.studio_source_signals (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 id text not null, source_id text not null, url text not null, title text not null, published_at timestamptz,
 observed_at timestamptz not null, topic_key text not null, metadata jsonb not null default '{}', primary key(workspace_id,id)
);
create index studio_signals_recent on public.studio_source_signals(workspace_id,observed_at desc);
create table public.studio_evidence_documents (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 id text not null, metadata jsonb not null, created_at timestamptz not null default now(), primary key(workspace_id,id)
);
create table public.studio_evidence_chunks (
 workspace_id uuid not null, document_id text not null, id text not null, metadata jsonb not null,
 keywords tsvector not null, embedding extensions.vector(384), embedding_version text,
 primary key(workspace_id,id), foreign key(workspace_id,document_id) references public.studio_evidence_documents(workspace_id,id) on delete cascade
);
create index studio_evidence_fts on public.studio_evidence_chunks using gin(keywords);
create table public.studio_research_steps (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 run_id uuid not null references public.studio_task_runs(id) on delete cascade, stage text not null, input_hash text not null,
 status text not null check(status in ('running','completed')), artifact_ref text, attempts integer not null default 1,
 model text, usage jsonb, attempt_metrics jsonb not null default '[]', started_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key(workspace_id,run_id,stage)
);
create table public.studio_topic_clusters (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 id text not null, run_id uuid not null references public.studio_task_runs(id) on delete cascade,
 metadata jsonb not null, updated_at timestamptz not null default now(), primary key(workspace_id,id)
);
create function public.studio_save_source(p_workspace uuid,p_source text,p_config jsonb)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if p_source is distinct from p_config->>'id' then raise exception 'Source identity mismatch'; end if;
 insert into public.studio_source_registry(workspace_id,id,config,next_poll_at) values(p_workspace,p_source,p_config,case when p_config->>'enabled'='true' and p_config->>'access' not in ('disabled','requires_authorization') then now() else null end)
 on conflict(workspace_id,id) do update set config=excluded.config,version=studio_source_registry.version+1,next_poll_at=excluded.next_poll_at,updated_at=now();
end $$;

create function public.studio_research_step(p_workspace uuid,p_run uuid,p_token uuid,p_stage text,p_input_hash text,p_model text,p_artifact text default null,p_limit integer default 12,p_usage jsonb default null)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare existing public.studio_research_steps; used integer;
begin
 perform 1 from public.studio_task_runs where id=p_run and workspace_id=p_workspace and lease_token=p_token and lease_expires_at>now() and status in('researching','generating') for update;
 if not found then raise exception 'Research run ownership changed'; end if;
 if p_stage!~'^[a-z0-9_]{1,100}$' or p_input_hash!~'^[a-f0-9]{64}$' or p_limit not between 1 and 40 then raise exception 'Invalid research step'; end if;
 select * into existing from public.studio_research_steps where workspace_id=p_workspace and run_id=p_run and stage=p_stage;
 if existing.stage is not null and existing.input_hash<>p_input_hash then raise exception 'Research step inputs changed'; end if;
 if existing.status='completed' then return to_jsonb(existing); end if;
 if p_artifact is not null then
  if existing.stage is null or p_artifact!~'^[a-f0-9]{64}$' then raise exception 'Research step was not started'; end if;
  update public.studio_research_steps set status='completed',artifact_ref=p_artifact,usage=p_usage,updated_at=now() where workspace_id=p_workspace and run_id=p_run and stage=p_stage returning * into existing;
 elsif p_usage is not null and existing.stage is not null then
  update public.studio_research_steps set usage=p_usage,updated_at=now() where workspace_id=p_workspace and run_id=p_run and stage=p_stage returning * into existing;
 else
  select coalesce(sum(attempts),0) into used from public.studio_research_steps where workspace_id=p_workspace and run_id=p_run and model is not null and (case when p_stage like 'variant_%' then stage like split_part(p_stage,'_',1)||'_'||split_part(p_stage,'_',2)||'_%' else stage not like 'variant_%' end);
  if p_model is not null and used>=p_limit then raise exception 'Research model budget exhausted'; end if;
  insert into public.studio_research_steps(workspace_id,run_id,stage,input_hash,status,model) values(p_workspace,p_run,p_stage,p_input_hash,'running',p_model)
   on conflict(workspace_id,run_id,stage) do update set attempts=studio_research_steps.attempts+1,attempt_metrics=case when studio_research_steps.usage is null then studio_research_steps.attempt_metrics else studio_research_steps.attempt_metrics||jsonb_build_array(jsonb_build_object('attempt',studio_research_steps.attempts,'usage',studio_research_steps.usage)) end,usage=null,started_at=now(),updated_at=now() returning * into existing;
 end if;
 return to_jsonb(existing);
end $$;

-- Defer the existing pgmq message rather than creating another run or schedule owner.
create function public.studio_defer_research(p_workspace uuid,p_run uuid,p_token uuid,p_delay integer,p_reason text)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare lease public.studio_queue_leases; result public.studio_task_runs;
begin
 if p_delay not between 30 and 86400 or p_reason not in ('quota','service') then raise exception 'Invalid research defer request'; end if;
 select l.* into lease from public.studio_queue_leases l join pgmq.q_studio_jobs q on q.msg_id=l.msg_id where l.workspace_id=p_workspace and l.token=p_token and l.expires_at>now() and q.message->>'id'=p_run::text and q.message->>'type'='task_run' for update of l;
 if lease.msg_id is null then return false; end if;
 update public.studio_task_runs set status='queued',phase='waiting_'||p_reason,error='Checkpoints retained; retry after '||(now()+make_interval(secs=>p_delay))::text,lease_token=null,lease_expires_at=null,updated_at=now()
 where workspace_id=p_workspace and id=p_run and lease_token=p_token and lease_expires_at>now() and status in ('researching','generating') returning * into result;
 if result.id is null then return false; end if;
 perform pgmq.set_vt('studio_jobs',lease.msg_id,p_delay);
 delete from public.studio_queue_leases where msg_id=lease.msg_id;
 insert into public.studio_run_events(workspace_id,run_id,status,phase,progress,message) values(p_workspace,p_run,result.status,result.phase,result.progress,result.error);
 return true;
end $$;

create function public.studio_evidence_search(p_workspace uuid,p_terms text,p_vector extensions.vector(384) default null,p_limit integer default 20,p_embedding_version text default 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3')
returns table(document_id text,chunk_id text,score double precision) language sql stable security definer set search_path=public,extensions,pg_catalog as $$
 with kw as (select c.id,row_number() over(order by ts_rank_cd(c.keywords,websearch_to_tsquery('simple',p_terms)) desc,c.id) r
  from public.studio_evidence_chunks c where c.workspace_id=p_workspace and c.keywords @@ websearch_to_tsquery('simple',p_terms) limit 60),
 sem as (select c.id,row_number() over(order by c.embedding <=> p_vector,c.id) r from public.studio_evidence_chunks c where c.workspace_id=p_workspace and p_vector is not null and c.embedding is not null and c.embedding_version=p_embedding_version order by c.embedding <=> p_vector limit 60)
 select c.document_id,c.id,(coalesce(1.0/(60+kw.r),0)+coalesce(1.0/(60+sem.r),0))::double precision
 from public.studio_evidence_chunks c left join kw on kw.id=c.id left join sem on sem.id=c.id
 where c.workspace_id=p_workspace and (kw.id is not null or sem.id is not null)
 order by 3 desc,c.id limit greatest(1,least(p_limit,40));
$$;
create function public.studio_commit_researched_article(p_workspace uuid,p_run uuid,p_token uuid,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 perform 1 from public.studio_task_runs where workspace_id=p_workspace and id=p_run and lease_token=p_token and lease_expires_at>now() and status in ('researching','generating') for update;
 if not found then raise exception 'Article production ownership changed'; end if;
 if p_content->>'id'<>p_run::text or p_content->>'generationEvidenceRunId'<>p_run::text or (p_content->>'revision')::integer<>1 then raise exception 'Invalid researched article identity'; end if;
 if not exists(select 1 from public.studio_research_steps where workspace_id=p_workspace and run_id=p_run and stage='quality_final' and status='completed') then raise exception 'Research quality gate is incomplete'; end if;
 return public.studio_commit_article(p_workspace,p_run,0,p_content);
end $$;
create function public.studio_put_evidence(p_workspace uuid,p_document jsonb,p_chunks jsonb)
returns void language plpgsql security definer set search_path=public,extensions,pg_catalog as $$
declare chunk jsonb;
begin
 if p_document->>'id'!~'^[a-f0-9]{64}$' or jsonb_typeof(p_chunks)<>'array' or jsonb_array_length(p_chunks)>10000 then raise exception 'Invalid evidence document'; end if;
 insert into public.studio_evidence_documents(workspace_id,id,metadata) values(p_workspace,p_document->>'id',p_document) on conflict do nothing;
 if not exists(select 1 from public.studio_evidence_documents where workspace_id=p_workspace and id=p_document->>'id' and metadata=p_document) then raise exception 'Immutable evidence differs'; end if;
 for chunk in select value from jsonb_array_elements(p_chunks) loop
  insert into public.studio_evidence_chunks(workspace_id,document_id,id,metadata,keywords,embedding,embedding_version)
   values(p_workspace,p_document->>'id',chunk->>'id',chunk->'metadata',to_tsvector('simple',chunk->>'terms'),(chunk->>'embedding')::extensions.vector,chunk->>'embeddingVersion') on conflict do nothing;
 end loop;
end $$;

create function public.studio_queue_source(p_workspace uuid,p_source text,p_slot text)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare config_value jsonb; job uuid;
begin
 select config into config_value from public.studio_source_registry where workspace_id=p_workspace and id=p_source for update;
 if config_value is null or config_value->>'enabled'<>'true' or config_value->>'access' in ('disabled','requires_authorization') then raise exception 'Source not enabled for collection'; end if;
 insert into public.studio_source_collections(workspace_id,source_id,slot,config) values(p_workspace,p_source,p_slot,config_value) on conflict(workspace_id,source_id,slot) do nothing returning id into job;
 if job is not null then perform public.studio_enqueue_work(p_workspace,'source_collect',job);
 else select id into job from public.studio_source_collections where workspace_id=p_workspace and source_id=p_source and slot=p_slot; end if;
 return job;
end $$;
create function public.studio_finish_source(p_workspace uuid,p_job uuid,p_token uuid,p_result text,p_signals jsonb,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare job public.studio_source_collections; item jsonb;
begin
 select * into job from public.studio_source_collections where workspace_id=p_workspace and id=p_job for update;
 if job.id is null or not exists(select 1 from public.studio_queue_leases l join pgmq.q_studio_jobs q on q.msg_id=l.msg_id where l.workspace_id=p_workspace and l.token=p_token and l.expires_at>now() and q.message->>'id'=p_job::text) then raise exception 'Source collection lease changed'; end if;
 if job.status<>'queued' then return; end if;
 for item in select value from jsonb_array_elements(p_signals) loop
  insert into public.studio_source_signals(workspace_id,id,source_id,url,title,published_at,observed_at,topic_key,metadata)
   values(p_workspace,item->>'id',job.source_id,item->>'url',item->>'title',(item->>'publishedAt')::timestamptz,(item->>'observedAt')::timestamptz,item->>'topicKey',item-'excerpt')
   on conflict(workspace_id,id) do update set observed_at=excluded.observed_at,metadata=excluded.metadata;
 end loop;
 update public.studio_source_collections set status=case when p_error is null then 'succeeded' else 'failed' end,result_ref=p_result,error=p_error,finished_at=now() where id=p_job;
 update public.studio_source_registry set health=health||jsonb_build_object('collectionStatus',case when p_error is null then 'available' else 'unavailable' end,'checkedAt',now(),'signalCount',jsonb_array_length(p_signals),'error',p_error),next_poll_at=now()+make_interval(mins=>(config->>'intervalMinutes')::integer) where workspace_id=p_workspace and id=job.source_id;
end $$;
create or replace function public.studio_dispatch_due_tasks(p_workspace uuid default null) returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare source record; dispatched integer;
begin
 dispatched:=public.studio_dispatch_content_tasks(p_workspace)+public.studio_dispatch_metric_polls(p_workspace);
 for source in select * from public.studio_source_registry s where (p_workspace is null or s.workspace_id=p_workspace) and s.next_poll_at<=now() and s.config->>'enabled'='true' and s.config->>'access' not in ('disabled','requires_authorization') for update skip locked limit 30 loop
  perform public.studio_queue_source(source.workspace_id,source.id,'scheduled:'||date_trunc('minute',now())::text);
  update public.studio_source_registry set next_poll_at=now()+make_interval(mins=>(config->>'intervalMinutes')::integer) where workspace_id=source.workspace_id and id=source.id;
 end loop;
 return dispatched;
end $$;

create function public.studio_production_metrics(p_workspace uuid,p_since timestamptz default now()-interval '7 days')
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $$
 with runs as (select * from public.studio_task_runs where workspace_id=p_workspace and created_at>=p_since and task_snapshot->>'pipelineVersion'='2'),
 steps as (select * from public.studio_research_steps where workspace_id=p_workspace and run_id in(select id from runs)),
 usage_samples as (select stage,usage from steps where usage is not null union all select stage,item->'usage' from steps cross join lateral jsonb_array_elements(attempt_metrics) item),
 calls as (select coalesce(sum(attempts) filter(where model is not null),0) total from steps),
 known as (select count(*) filter(where jsonb_typeof(usage->'inputTokens')='number' and jsonb_typeof(usage->'outputTokens')='number') samples,
 sum((usage->>'inputTokens')::bigint) input_tokens,sum((usage->>'outputTokens')::bigint) output_tokens,sum((usage->>'cost')::numeric) cost from usage_samples),
 sources as (select count(*) filter(where status='succeeded') succeeded,count(*) filter(where status='failed') failed from public.studio_source_collections where workspace_id=p_workspace and created_at>=p_since),
 article as (select count(*) total,count(*) filter(where status='succeeded' and draft_id is not null) passed from runs where task_snapshot->>'kind'='content'),
 durations as (select stage,count(*) samples,avg((usage->>'durationMs')::numeric) duration_ms from usage_samples where usage->>'durationMs' is not null group by stage),
 evidence as (select avg(extract(epoch from now()-(metadata->>'fetchedAt')::timestamptz)/3600.0) age_hours from public.studio_evidence_documents where workspace_id=p_workspace and created_at>=p_since)
 select jsonb_build_object('since',p_since,'checkedAt',now(),'engine','pgmq','scheduler','pg_cron',
 'sources',jsonb_build_object('succeeded',sources.succeeded,'failed',sources.failed,'failureRate',sources.failed::numeric/nullif(sources.failed+sources.succeeded,0)),
 'articles',jsonb_build_object('attempted',article.total,'qualified',article.passed,'qualifiedRate',article.passed::numeric/nullif(article.total,0),'supplementedRuns',(select count(distinct run_id) from steps where stage like 'supplement_%')),
 'model',jsonb_build_object('attempts',calls.total,'knownCalls',known.samples,'unknownCalls',calls.total-known.samples,'confirmedInputTokens',known.input_tokens,'confirmedOutputTokens',known.output_tokens,'confirmedCost',known.cost),
 'evidenceMeanAgeHours',evidence.age_hours,'stages',coalesce((select jsonb_agg(jsonb_build_object('stage',stage,'samples',samples,'meanMs',duration_ms)) from durations),'[]'::jsonb),
 'editedAfterProduction',(select count(*) from public.content_studio_workspaces w cross join lateral jsonb_array_elements(w.state->'drafts') d where w.id=p_workspace and (d->>'revision')::integer>1 and d->>'generationEvidenceRunId' in(select id::text from runs)))
 from calls,known,sources,article,evidence;
$$;

do $$ declare name text; signature regprocedure; begin
 foreach name in array array['studio_source_registry','studio_source_collections','studio_source_signals','studio_evidence_documents','studio_evidence_chunks','studio_research_steps','studio_topic_clusters'] loop
 execute format('alter table public.%I enable row level security',name);
 execute format('revoke all on public.%I from public,anon,authenticated',name);
 execute format('grant all on public.%I to service_role',name);
 end loop;
 for signature in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in('studio_research_step','studio_defer_research','studio_evidence_search','studio_put_evidence','studio_commit_researched_article','studio_save_source','studio_queue_source','studio_finish_source','studio_dispatch_due_tasks','studio_production_metrics') loop
 execute format('revoke all on function %s from public,anon,authenticated',signature);
 execute format('grant execute on function %s to service_role',signature);
 end loop;
end $$;
notify pgrst,'reload schema';

create or replace function public.studio_claim_role_work(p_workspace uuid,p_role text)
returns jsonb language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare message pgmq.q_studio_jobs%rowtype; owner_token uuid:=gen_random_uuid();
begin
  if p_role not in ('article','video','delivery','all') then raise exception 'Unknown worker role'; end if;
  select q.* into message from pgmq.q_studio_jobs q
    where q.vt<=now() and q.message->>'workspaceId'=p_workspace::text and (
      p_role='all' or p_role='article' and q.message->>'type' in ('task_run','source_collect') or
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
    if message.message->>'type'='source_collect' then update public.studio_source_collections set status='failed',error='Collection retry budget exhausted',finished_at=now() where id=(message.message->>'id')::uuid and workspace_id=p_workspace and status='queued'; end if;
    perform pgmq.archive('studio_jobs',p_msg);
  else
    perform pgmq.set_vt('studio_jobs',p_msg,least(300,(power(2,message.read_ct)*5)::integer));
  end if;
  delete from public.studio_queue_leases where msg_id=p_msg;
  return true;
end $$;
