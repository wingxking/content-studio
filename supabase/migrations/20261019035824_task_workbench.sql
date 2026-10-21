-- Additive workbench metadata. Existing article/video snapshots and hashes remain authoritative.
create table public.studio_article_origins (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade, draft_id uuid not null,
 task_id uuid not null references public.studio_tasks(id) on delete cascade, origin_run_id uuid not null references public.studio_task_runs(id) on delete cascade,
 primary key(workspace_id,draft_id)
);
create index studio_article_origins_task on public.studio_article_origins(workspace_id,task_id,origin_run_id);
with candidates as (
 select workspace_id,draft_id,task_id,id,count(*) over(partition by workspace_id,draft_id) n
 from public.studio_task_runs where draft_id is not null and refresh_draft_id is null
), selected as (select distinct on(workspace_id,draft_id) * from candidates where id=draft_id or n=1 order by workspace_id,draft_id,id)
insert into public.studio_article_origins select workspace_id,draft_id,task_id,id from selected;
create function public.studio_remember_article_origin() returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 if new.draft_id is not null and new.refresh_draft_id is null then
  insert into public.studio_article_origins values(new.workspace_id,new.draft_id,new.task_id,new.id) on conflict do nothing;
 end if;
 return new;
end $$;
create trigger studio_article_origin after insert or update of draft_id on public.studio_task_runs for each row execute function public.studio_remember_article_origin();

create table public.studio_task_links (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 parent_task_id uuid not null references public.studio_tasks(id) on delete cascade, parent_run_id uuid not null references public.studio_task_runs(id) on delete cascade,
 child_task_id uuid not null references public.studio_tasks(id) on delete cascade, relation text not null check(relation in ('question_derived','cloned_from')), question_index integer check(question_index between 0 and 19),
 primary key(workspace_id,child_task_id)
);
insert into public.studio_task_links select p.workspace_id,t.task_id,t.id,p.child_task_id,'question_derived',p.candidate_index
from public.studio_discovery_promotions p join public.studio_task_runs t on t.id=p.parent_run_id and t.workspace_id=p.workspace_id on conflict do nothing;
create index studio_task_links_parent on public.studio_task_links(workspace_id,parent_task_id,parent_run_id);
create function public.studio_remember_discovery_link() returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 insert into public.studio_task_links select new.workspace_id,r.task_id,new.parent_run_id,new.child_task_id,'question_derived',new.candidate_index from public.studio_task_runs r where r.workspace_id=new.workspace_id and r.id=new.parent_run_id on conflict do nothing;
 return new;
end $$;
create trigger studio_discovery_link after insert on public.studio_discovery_promotions for each row execute function public.studio_remember_discovery_link();
revoke all on function public.studio_remember_discovery_link() from public,anon,authenticated;
create table public.studio_task_presentation (
 workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade, kind text not null check(kind in ('plan','video','article')),
 subject_id uuid not null, tags jsonb not null default '[]', archived_at timestamptz,
 primary key(workspace_id,kind,subject_id), check(jsonb_typeof(tags)='array' and jsonb_array_length(tags)<=12)
);
create table public.studio_library_entries (
 id uuid primary key, workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade, title text not null check(length(title) between 1 and 300),
 url text not null check(length(url)<=2000), excerpt text not null check(length(excerpt)<=12000), created_at timestamptz not null default now()
);
create table public.studio_task_resources (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade,
 task_kind text not null check(task_kind in ('plan','video','article')), task_id uuid not null, episode_id uuid,
 resource_kind text not null check(resource_kind in ('capture','asset','knowledge')), resource_id uuid not null,
 created_at timestamptz not null default now(), unique nulls not distinct(workspace_id,task_kind,task_id,episode_id,resource_kind,resource_id)
);
create index studio_task_resources_owner on public.studio_task_resources(workspace_id,task_kind,task_id,episode_id);
create table public.studio_delivery_batches (
 id uuid not null, workspace_id uuid not null references public.content_studio_workspaces(id) on delete cascade, request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), primary key(workspace_id,id)
);
create table public.studio_delivery_batch_items (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null, batch_id uuid not null, input jsonb not null,
 status text not null default 'pending' check(status in ('pending','accepted','blocked','failed')), job_id uuid, error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(workspace_id,batch_id) references public.studio_delivery_batches(workspace_id,id) on delete cascade
);
create index studio_delivery_batch_items_batch on public.studio_delivery_batch_items(workspace_id,batch_id,created_at,id);

create function public.studio_create_delivery_batch(p_workspace uuid,p_id uuid,p_hash text,p_items jsonb)
returns uuid language plpgsql security invoker set search_path=public,pgmq,pg_catalog as $$
declare prior text; item jsonb; item_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_workspace::text||p_id::text,0));
 select request_hash into prior from public.studio_delivery_batches where workspace_id=p_workspace and id=p_id;
 if found then if prior<>p_hash then raise exception 'Batch command changed'; end if; return p_id; end if;
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Invalid batch size'; end if;
 insert into public.studio_delivery_batches(id,workspace_id,request_hash) values(p_id,p_workspace,p_hash);
 for item in select value from jsonb_array_elements(p_items) loop
  insert into public.studio_delivery_batch_items(workspace_id,batch_id,input) values(p_workspace,p_id,item) returning id into item_id;
  perform public.studio_enqueue_work(p_workspace,'delivery_batch_item',item_id);
 end loop;
 return p_id;
end $$;

create function public.studio_bind_batch_job(p_workspace uuid,p_item uuid,p_job uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
begin
 if not exists(select 1 from public.studio_queue_leases l join pgmq.q_studio_jobs q on q.msg_id=l.msg_id where l.workspace_id=p_workspace and l.token=p_token and l.expires_at>now() and q.message->>'type'='delivery_batch_item' and q.message->>'id'=p_item::text) then raise exception 'Batch ownership changed'; end if;
 update public.studio_delivery_batch_items set job_id=p_job,updated_at=now() where workspace_id=p_workspace and id=p_item and status='pending' and (job_id is null or job_id=p_job);
 if not found then raise exception 'Batch item changed'; end if;
 return true;
end $$;
create function public.studio_finish_batch_item(p_workspace uuid,p_item uuid,p_token uuid,p_job uuid,p_error text)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
begin
 if not exists(select 1 from public.studio_queue_leases l join pgmq.q_studio_jobs q on q.msg_id=l.msg_id where l.workspace_id=p_workspace and l.token=p_token and l.expires_at>now() and q.message->>'type'='delivery_batch_item' and q.message->>'id'=p_item::text) then raise exception 'Batch ownership changed'; end if;
 update public.studio_delivery_batch_items set job_id=p_job,status=case when p_error is null then 'accepted' else 'blocked' end,error=left(p_error,2000),updated_at=now() where workspace_id=p_workspace and id=p_item and status='pending';
 return found;
end $$;
revoke all on function public.studio_bind_batch_job(uuid,uuid,uuid,uuid),public.studio_finish_batch_item(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.studio_bind_batch_job(uuid,uuid,uuid,uuid),public.studio_finish_batch_item(uuid,uuid,uuid,uuid,text) to service_role;

create function public.studio_task_index(p_workspace uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 51,p_search text default '',p_archived boolean default false,p_kind text default null,p_tag text default null)
returns jsonb language sql stable security invoker set search_path=public,pg_catalog as $$
with all_items as (
 select t.id,'plan'::text kind,t.config->>'kind' category,t.config->>'title' title,t.created_at,
  case when coalesce((t.config->>'enabled')::boolean,false) then 'enabled' else 'paused' end status,t.next_run_at,
  (select count(*) from public.studio_task_runs r where r.workspace_id=p_workspace and r.task_id=t.id and r.refresh_draft_id is null) episodes
 from public.studio_tasks t where t.workspace_id=p_workspace
 and not exists(select 1 from public.studio_task_links l where l.workspace_id=p_workspace and l.child_task_id=t.id and l.relation='question_derived')
 and not exists(select 1 from public.studio_discovery_promotions l where l.workspace_id=p_workspace and l.child_task_id=t.id)
 union all
 select v.id,'video','video',coalesce(v.content#>>'{brief,topic}','Video'),(v.content->>'createdAt')::timestamptz,v.content->>'status',null::timestamptz,1
 from public.studio_video_projects v where v.workspace_id=p_workspace
 union all
 select (d->>'id')::uuid,'article','article',d->>'title',(d->>'createdAt')::timestamptz,'standalone',null::timestamptz,1
 from public.content_studio_workspaces w cross join lateral jsonb_array_elements(w.state->'drafts') d where w.id=p_workspace
 and not exists(select 1 from public.studio_article_origins o where o.workspace_id=p_workspace and o.draft_id=(d->>'id')::uuid)
), selected as (
 select a.*,coalesce(p.tags,'[]'::jsonb) tags,p.archived_at from all_items a
 left join public.studio_task_presentation p on p.workspace_id=p_workspace and p.kind=a.kind and p.subject_id=a.id
 where (p_before is null or (a.created_at,a.id)<(p_before,p_before_id)) and (p_search='' or a.title ilike '%'||p_search||'%')
 and (p_kind is null or a.category=p_kind) and (p_tag is null or p.tags ? p_tag)
 and (p_archived=(p.archived_at is not null)) order by a.created_at desc,a.id desc limit least(greatest(p_limit,1),101)
) select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'category',category,'title',title,'createdAt',created_at,'status',status,'nextRunAt',next_run_at,'episodeCount',episodes,'tags',tags,'archivedAt',archived_at) order by created_at desc,id desc),'[]') from selected;
$$;

create function public.studio_article_detail(p_workspace uuid,p_id uuid)
returns jsonb language sql stable security invoker set search_path=public,pg_catalog as $$
 select jsonb_build_object('draft',d,'jobs',coalesce((select jsonb_agg(j) from jsonb_array_elements(w.state->'jobs') j where j->>'draftId'=p_id::text),'[]'))
 from public.content_studio_workspaces w cross join lateral jsonb_array_elements(w.state->'drafts') d where w.id=p_workspace and d->>'id'=p_id::text;
$$;
create function public.studio_task_can_archive(p_workspace uuid,p_kind text,p_id uuid)
returns boolean language sql stable security invoker set search_path=public,pg_catalog as $$
with owners as (select p_id id union select child_task_id from public.studio_task_links where workspace_id=p_workspace and parent_task_id=p_id and relation='question_derived')
select not exists(select 1 from public.studio_task_runs r where p_kind='plan' and r.workspace_id=p_workspace and r.task_id in(select id from owners) and r.status in('queued','researching','generating'))
and not exists(select 1 from public.studio_video_projects v where p_kind='video' and v.workspace_id=p_workspace and v.id=p_id and v.content->>'status'='rendering')
and not exists(select 1 from public.content_studio_workspaces w cross join lateral jsonb_array_elements(w.state->'jobs') j where w.id=p_workspace and j->>'status' in('scheduled','submitting','queued','needs_reconciliation','awaiting_operator') and
 (p_kind='video' and j#>>'{subject,kind}'='video' and j#>>'{subject,id}'=p_id::text or p_kind='article' and j->>'draftId'=p_id::text or p_kind='plan' and exists(select 1 from public.studio_article_origins o where o.workspace_id=p_workspace and o.task_id in(select id from owners) and o.draft_id::text=j->>'draftId')));
$$;
revoke all on function public.studio_task_can_archive(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.studio_task_can_archive(uuid,text,uuid) to service_role;

do $$ declare name text; begin
 foreach name in array array['studio_article_origins','studio_task_links','studio_task_presentation','studio_library_entries','studio_task_resources','studio_delivery_batches','studio_delivery_batch_items'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant select,insert,update,delete on public.%I to service_role',name);
 end loop;
end $$;
revoke all on function public.studio_remember_article_origin(),public.studio_create_delivery_batch(uuid,uuid,text,jsonb),public.studio_task_index(uuid,timestamptz,uuid,integer,text,boolean,text,text),public.studio_article_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.studio_create_delivery_batch(uuid,uuid,text,jsonb),public.studio_task_index(uuid,timestamptz,uuid,integer,text,boolean,text,text),public.studio_article_detail(uuid,uuid) to service_role;

-- Discovery batches include both automatic promotions and explicit question-derived tasks.
create or replace function public.studio_list_content(p_workspace uuid,p_kind text default null,p_platform text default null,p_task uuid default null,p_run uuid default null,p_status text default null,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 51,p_from timestamptz default null,p_to timestamptz default null)
returns jsonb language sql stable security definer set search_path=public,pg_catalog as $$
 with workspace as (select state from public.content_studio_workspaces where id=p_workspace),
 articles as (
  select (d->>'id')::uuid id,'article'::text kind,d->>'title' title,(d->>'revision')::integer revision,
   (select coalesce(jsonb_agg(distinct platform),'[]'::jsonb) from (select v->>'platform' platform from jsonb_array_elements(d->'variants') v union select v->>'platform' from public.studio_revisions h cross join lateral jsonb_array_elements(h.content->'variants') v where h.workspace_id=p_workspace and h.draft_id=(d->>'id')::uuid union select j->>'platform' from jsonb_array_elements(w.state->'jobs') j where j->>'draftId'=d->>'id') destinations) platforms,
   (d->>'createdAt')::timestamptz created_at,(d->>'createdAt')::timestamptz updated_at,
   coalesce(delivery.status,case when nullif(d->>'approvedHash','') is not null then 'approved' else 'generated' end) status,
   r.task_id,r.id run_id
  from workspace w cross join lateral jsonb_array_elements(w.state->'drafts') d
  left join lateral (select j->>'status' status from jsonb_array_elements(w.state->'jobs') j where j->>'draftId'=d->>'id' and (p_platform is null or j->>'platform'=p_platform) and (p_status is null or p_status='generated' or j->>'status'=p_status) order by j->>'createdAt' desc limit 1) delivery on true
  left join lateral (select origin_run_id id,task_id from public.studio_article_origins where workspace_id=p_workspace and draft_id=(d->>'id')::uuid) r on true
 ), videos as (
  select v.id,'video'::text kind,coalesce(v.content#>>'{brief,topic}','Video') title,(v.content->>'revision')::integer revision,
   case when jsonb_array_length(coalesce(v.content->'targets','[]'::jsonb))>0 then (select jsonb_agg(distinct t->>'platform') from jsonb_array_elements(v.content->'targets') t) else jsonb_build_array(v.content#>>'{brief,platform}') end platforms,
   (v.content->>'createdAt')::timestamptz created_at,v.updated_at,coalesce(delivery.status,'generated') status,null::uuid task_id,null::uuid run_id
  from public.studio_video_projects v cross join workspace w
  left join lateral (select j->>'status' status from jsonb_array_elements(w.state->'jobs') j where j#>>'{subject,kind}'='video' and j#>>'{subject,id}'=v.id::text and (p_platform is null or j->>'platform'=p_platform) and (p_status is null or p_status='generated' or j->>'status'=p_status) order by j->>'createdAt' desc limit 1) delivery on true
  where v.workspace_id=p_workspace
 ), filtered as (
  select * from (select * from articles union all select * from videos) c
  where (p_kind is null or kind=p_kind) and (p_platform is null or platforms ? p_platform)
   and (p_task is null or task_id=p_task or exists(select 1 from public.studio_task_links l where l.workspace_id=p_workspace and l.child_task_id=c.task_id and l.parent_task_id=p_task and l.relation='question_derived') or exists(select 1 from public.studio_discovery_promotions pr join public.studio_task_runs parent on parent.id=pr.parent_run_id and parent.workspace_id=p_workspace where pr.workspace_id=p_workspace and pr.child_task_id=c.task_id and parent.task_id=p_task))
   and (p_status is null or p_status='generated' or status=p_status)
   and (p_run is null or run_id=p_run or exists(select 1 from public.studio_task_links l where l.workspace_id=p_workspace and l.child_task_id=c.task_id and l.parent_run_id=p_run and l.relation='question_derived') or exists(select 1 from public.studio_discovery_promotions pr where pr.workspace_id=p_workspace and pr.parent_run_id=p_run and pr.child_task_id=c.task_id))
   and (p_from is null or created_at>=p_from) and (p_to is null or created_at<=p_to)
   and (p_before is null or (created_at,id)<(p_before,p_before_id))
  order by created_at desc,id desc limit least(greatest(p_limit,1),101)
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'title',title,'revision',revision,'platforms',platforms,'createdAt',created_at,'updatedAt',updated_at,'status',status,'taskId',task_id,'runId',run_id) order by created_at desc,id desc),'[]'::jsonb) from filtered;
$$;


create or replace function public.studio_claim_role_work(p_workspace uuid,p_role text)
returns jsonb language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare message pgmq.q_studio_jobs%rowtype; owner_token uuid:=gen_random_uuid();
begin
  if p_role not in ('article','video','delivery','all') then raise exception 'Unknown worker role'; end if;
  select q.* into message from pgmq.q_studio_jobs q
    where q.vt<=now() and q.message->>'workspaceId'=p_workspace::text and (
      p_role='all' or p_role='article' and q.message->>'type' in ('task_run','source_collect') or
      p_role='delivery' and q.message->>'type' in ('legacy_publish','delivery_batch_item') or
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
create function public.studio_delivery_page(p_workspace uuid,p_view text default 'pending',p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 51,p_from timestamptz default null,p_to timestamptz default null)
returns jsonb language sql stable security invoker set search_path=public,pg_catalog as $$
with items as (
 select j,(j->>'id')::uuid id,(j->>'createdAt')::timestamptz created_at,
 coalesce(j#>>'{subject,kind}',case when j#>>'{snapshot,video,projectId}' is not null then 'video' else 'article' end) kind,
 coalesce(j#>>'{subject,id}',j->>'draftId',j#>>'{snapshot,video,projectId}') subject_id
 from public.content_studio_workspaces w cross join lateral jsonb_array_elements(w.state->'jobs') j where w.id=p_workspace
), selected as (
 select * from items where (p_before is null or (created_at,id)<(p_before,p_before_id))
 and (p_view='all' or p_view='pending' and j->>'status' in ('failed','needs_reconciliation','awaiting_operator','submitting','queued')
 or p_view='drafts' and j->>'deliveryAction'='save_draft'
 or p_view='history' and j->>'status'='published'
 or p_view='calendar' and coalesce(j->>'deliveryAction','publish')<>'save_draft' and j->>'status' in ('scheduled','submitting','queued','published'))
 and (p_from is null or (j->>'scheduledAt')::timestamptz>=p_from) and (p_to is null or (j->>'scheduledAt')::timestamptz<=p_to)
 order by created_at desc,id desc limit least(greatest(p_limit,1),101)
) select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',coalesce(j#>>'{snapshot,variant,title}','Historical delivery'),'subjectKind',kind,'subjectId',subject_id,'revision',coalesce(j#>>'{subject,revision}',j#>>'{snapshot,draft,revision}',j#>>'{snapshot,video,revision}','1')::integer,'accountId',j->>'accountId','platform',j->>'platform','status',j->>'status','draftOnly',coalesce(j->>'deliveryAction'='save_draft',false),'scheduledAt',j->>'scheduledAt','createdAt',created_at,'remoteUrl',j->>'remoteUrl','ref',jsonb_build_object('kind',case when kind='video' then 'video' when o.task_id is not null then 'plan' else 'article' end,'id',case when kind='video' then subject_id when o.task_id is not null then o.task_id::text else subject_id end),'episodeId',o.origin_run_id) order by created_at desc,s.id desc),'[]')
from selected s left join public.studio_article_origins o on kind='article' and o.workspace_id=p_workspace and o.draft_id=subject_id::uuid;
$$;
revoke all on function public.studio_delivery_page(uuid,text,timestamptz,uuid,integer,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.studio_delivery_page(uuid,text,timestamptz,uuid,integer,timestamptz,timestamptz) to service_role;
create or replace function public.studio_fail_role_work(p_workspace uuid,p_msg bigint,p_token uuid,p_error text)
returns boolean language plpgsql security definer set search_path=public,pgmq,pg_catalog as $$
declare lease public.studio_queue_leases%rowtype; message pgmq.q_studio_jobs%rowtype;
begin
  select * into lease from public.studio_queue_leases where msg_id=p_msg and workspace_id=p_workspace for update;
  if not found or lease.token<>p_token or lease.expires_at<now() then return false; end if;
  select * into message from pgmq.q_studio_jobs where msg_id=p_msg for update;
  if not found then return false; end if;
  if message.read_ct>=5 then
    if message.message->>'type'='delivery_batch_item' then update public.studio_delivery_batch_items set status='failed',error='处理重试次数已用尽，请打开任务检查。',updated_at=now() where workspace_id=p_workspace and id=(message.message->>'id')::uuid and status='pending'; end if;
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
notify pgrst,'reload schema';
