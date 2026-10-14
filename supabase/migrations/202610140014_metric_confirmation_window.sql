create or replace function public.studio_configure_metric_poll(p_workspace uuid,p_job uuid,p_enabled boolean,p_new_window boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare job jsonb; item public.studio_metric_polls%rowtype;
begin
 select value into job from public.content_studio_workspaces w,jsonb_array_elements(w.state->'jobs') value where w.id=p_workspace and value->>'id'=p_job::text;
 if job is null or job->>'status' not in ('published','delivered') or job->>'remoteId' is null or job->>'deliveryAction'='save_draft' then raise exception 'Confirmed work required';end if;
 insert into public.studio_metric_polls(workspace_id,job_id,started_at,deadline,next_at) select p_workspace,p_job,confirmed,confirmed+interval '16 hours',confirmed+interval '1 minute' from (select coalesce(max((entry->>'at')::timestamptz),now()) confirmed from jsonb_array_elements(coalesce(job->'history','[]'::jsonb)) entry where entry->>'status' in ('published','delivered')) timing on conflict do nothing;
 select * into item from public.studio_metric_polls where workspace_id=p_workspace and job_id=p_job for update;
 if p_new_window then update public.studio_metric_polls set started_at=now(),deadline=now()+interval '16 hours',next_at=now()+interval '1 minute',blocked_reason=null where workspace_id=p_workspace and job_id=p_job;
 elsif p_enabled and item.deadline<=now() then raise exception 'Window expired; request an explicit new window'; end if;
 update public.studio_metric_polls set enabled=p_enabled,blocked_reason=case when p_enabled then null else blocked_reason end where workspace_id=p_workspace and job_id=p_job returning * into item;
 return to_jsonb(item);
end $$;
create or replace function public.studio_queue_metric_collection(p_workspace uuid,p_job uuid,p_manual boolean default false)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare job jsonb; poll public.studio_metric_polls%rowtype; attempt uuid:=gen_random_uuid();operation uuid:=gen_random_uuid();slot_value bigint;
begin
 select value into job from public.content_studio_workspaces w,jsonb_array_elements(w.state->'jobs') value where w.id=p_workspace and value->>'id'=p_job::text;
 if job is null or job->>'status' not in ('published','delivered') or job->>'remoteId' is null or job->>'deliveryAction'='save_draft' then raise exception 'Confirmed work required';end if;
 insert into public.studio_metric_polls(workspace_id,job_id,started_at,deadline,next_at) select p_workspace,p_job,confirmed,confirmed+interval '16 hours',confirmed+interval '1 minute' from (select coalesce(max((entry->>'at')::timestamptz),now()) confirmed from jsonb_array_elements(coalesce(job->'history','[]'::jsonb)) entry where entry->>'status' in ('published','delivered')) timing on conflict do nothing;
 select * into poll from public.studio_metric_polls where workspace_id=p_workspace and job_id=p_job for update;
 if poll.deadline<=now() or not p_manual and (not poll.enabled or poll.next_at>now()) then raise exception 'Metric slot is inactive or expired';end if;
 -- Real wall-clock ten-minute slots deduplicate manual and scheduled requests, including explicit new windows.
 slot_value:=floor(extract(epoch from now())/600)::bigint;
 select operation_id into operation from public.studio_metric_attempts where workspace_id=p_workspace and job_id=p_job and slot=slot_value;
 if found then return operation;end if;
 operation:=gen_random_uuid();
 insert into public.studio_metric_attempts(id,workspace_id,job_id,slot,operation_id) values(attempt,p_workspace,p_job,slot_value,operation);
 insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input)
 values(operation,p_workspace,(job->>'draftId')::uuid,coalesce(job->'subject'->>'kind','article'),coalesce((job->'subject'->>'id')::uuid,(job->>'draftId')::uuid),'collect_metrics',jsonb_build_object('jobId',p_job,'attemptId',attempt));
 perform public.studio_enqueue_work(p_workspace,'studio_operation',operation);
 update public.studio_metric_polls set next_at=now()+interval '10 minutes' where workspace_id=p_workspace and job_id=p_job;
 return operation;
end $$;

notify pgrst,'reload schema';
