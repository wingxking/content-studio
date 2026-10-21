-- Freshness repair is a new bounded run, never a rewrite of frozen checkpoints.
alter table public.studio_task_runs add column refresh_draft_id uuid;
alter table public.studio_task_runs add column refresh_revision integer;
alter table public.studio_task_runs add column refresh_reason text;
alter table public.studio_task_runs add constraint studio_refresh_target_valid check (
 (refresh_draft_id is null and refresh_revision is null and refresh_reason is null) or
 (refresh_draft_id is not null and refresh_revision>0 and refresh_reason in ('review_expired','source_changed'))
);

create function public.studio_request_evidence_refresh(p_workspace uuid,p_draft uuid,p_revision integer,p_reason text)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare state_value jsonb; draft jsonb; parent public.studio_task_runs; refresh_id uuid; slot_value text;
begin
 if p_reason not in ('review_expired','source_changed') then raise exception 'Invalid evidence refresh reason'; end if;
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

create or replace function public.studio_commit_researched_article(p_workspace uuid,p_run uuid,p_token uuid,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare run public.studio_task_runs; expected_revision integer; target uuid;
begin
 select * into run from public.studio_task_runs where workspace_id=p_workspace and id=p_run and lease_token=p_token and lease_expires_at>now() and status in ('researching','generating') for update;
 if run.id is null then raise exception 'Article production ownership changed'; end if;
 expected_revision:=coalesce(run.refresh_revision,0); target:=coalesce(run.refresh_draft_id,p_run);
 if p_content->>'id' is distinct from target::text or p_content->>'generationEvidenceRunId' is distinct from p_run::text or (p_content->>'revision')::integer is distinct from expected_revision+1 or p_content->'approvedHash' is distinct from 'null'::jsonb then raise exception 'Invalid researched article identity'; end if;
 if not exists(select 1 from public.studio_research_steps where workspace_id=p_workspace and run_id=p_run and stage='quality_final' and status='completed') then raise exception 'Research quality gate is incomplete'; end if;
 return public.studio_commit_article(p_workspace,p_run,expected_revision,p_content);
end $$;
revoke all on function public.studio_request_evidence_refresh(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.studio_request_evidence_refresh(uuid,uuid,integer,text) to service_role;
notify pgrst,'reload schema';
