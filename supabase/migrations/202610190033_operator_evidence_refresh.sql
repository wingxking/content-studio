-- An explicit operator request reuses the revision-bound research repair path.
-- Existing approved content is retained in history; the new revision needs review.
alter table public.studio_task_runs drop constraint studio_refresh_target_valid;
alter table public.studio_task_runs add constraint studio_refresh_target_valid check (
 (refresh_draft_id is null and refresh_revision is null and refresh_reason is null) or
 (refresh_draft_id is not null and refresh_revision>0 and refresh_reason in ('review_expired','source_changed','review_requested'))
);

create or replace function public.studio_request_evidence_refresh(p_workspace uuid,p_draft uuid,p_revision integer,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare state_value jsonb; draft jsonb; parent public.studio_task_runs; refresh_id uuid; slot_value text;
begin
 if p_reason not in ('review_expired','source_changed','review_requested') then raise exception 'Invalid evidence refresh reason'; end if;
 select state into state_value from public.content_studio_workspaces where id=p_workspace for update;
 select value into draft from jsonb_array_elements(state_value->'drafts') where value->>'id'=p_draft::text;
 if draft is null or (draft->>'revision')::integer<>p_revision then raise exception 'Draft revision changed before evidence refresh'; end if;
 select * into parent from public.studio_task_runs where workspace_id=p_workspace and id=(draft->>'generationEvidenceRunId')::uuid and draft_id=p_draft and status='succeeded' and task_snapshot->>'pipelineVersion'='2';
 if parent.id is null or not exists(select 1 from public.studio_research_steps where workspace_id=p_workspace and run_id=parent.id and stage='quality_final' and status='completed') then raise exception 'Evidence production lineage is unavailable'; end if;
 slot_value:='evidence-refresh:'||p_draft::text||':'||p_revision::text;
 insert into public.studio_task_runs(workspace_id,task_id,slot,task_snapshot,refresh_draft_id,refresh_revision,refresh_reason)
 values(p_workspace,parent.task_id,slot_value,parent.task_snapshot,p_draft,p_revision,p_reason)
 on conflict(workspace_id,task_id,slot) do nothing returning id into refresh_id;
 if refresh_id is null then select id into refresh_id from public.studio_task_runs where workspace_id=p_workspace and task_id=parent.task_id and slot=slot_value;
 else perform public.studio_enqueue_work(p_workspace,'task_run',refresh_id); end if;
 return refresh_id;
end $$;
revoke all on function public.studio_request_evidence_refresh(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.studio_request_evidence_refresh(uuid,uuid,integer,text) to service_role;
notify pgrst,'reload schema';
