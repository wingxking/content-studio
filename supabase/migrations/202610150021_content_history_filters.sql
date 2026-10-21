-- Platform history filters bind the selected platform and include prior article destinations.
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
  left join lateral (select id,task_id from public.studio_task_runs where workspace_id=p_workspace and draft_id=(d->>'id')::uuid order by created_at desc limit 1) r on true
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
   and (p_task is null or task_id=p_task) and (p_status is null or p_status='generated' or status=p_status)
   and (p_run is null or run_id=p_run or exists(select 1 from public.studio_discovery_promotions pr where pr.workspace_id=p_workspace and pr.parent_run_id=p_run and pr.child_run_id=c.run_id))
   and (p_from is null or created_at>=p_from) and (p_to is null or created_at<=p_to)
   and (p_before is null or (created_at,id)<(p_before,p_before_id))
  order by created_at desc,id desc limit least(greatest(p_limit,1),101)
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'title',title,'revision',revision,'platforms',platforms,'createdAt',created_at,'updatedAt',updated_at,'status',status,'taskId',task_id,'runId',run_id) order by created_at desc,id desc),'[]'::jsonb) from filtered;
$$;

notify pgrst,'reload schema';
