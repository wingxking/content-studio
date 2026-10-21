-- Transaction-only tests. The caller applies 026–030 inside BEGIN/ROLLBACK.
do $$
declare workspace uuid:=gen_random_uuid(); task uuid:=gen_random_uuid(); original uuid:=gen_random_uuid(); refresh uuid; second uuid; token uuid:=gen_random_uuid(); content jsonb; saved jsonb;
begin
 insert into public.content_studio_workspaces(id,state) values(workspace,'{"paused":true,"accounts":[],"drafts":[],"jobs":[]}'::jsonb);
 insert into public.studio_tasks(id,workspace_id,config) values(task,workspace,'{}');
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,draft_id) values(original,workspace,task,'fixture','{"pipelineVersion":2,"kind":"content"}','succeeded',original);
 insert into public.studio_research_steps(workspace_id,run_id,stage,input_hash,status,attempts,artifact_ref) values(workspace,original,'quality_final',repeat('a',64),'completed',1,repeat('b',64));
 content:=jsonb_build_object('id',original,'revision',1,'title','Original','body','Old evidence','variants','[]'::jsonb,'brief','{}'::jsonb,'approvedHash','old-approval','generationEvidenceRunId',original);
 perform public.studio_commit_article(workspace,original,0,content);
 refresh:=public.studio_request_evidence_refresh(workspace,original,1,'review_expired');
 if public.studio_request_evidence_refresh(workspace,original,1,'source_changed')<>refresh then raise exception 'Refresh request was not idempotent'; end if;
 if not exists(select 1 from public.studio_task_runs where id=refresh and refresh_draft_id=original and refresh_revision=1) then raise exception 'Refresh lost revision binding'; end if;
 update public.studio_task_runs set status='researching',lease_token=token,lease_expires_at=now()+interval '5 minutes' where id=refresh;
 insert into public.studio_research_steps(workspace_id,run_id,stage,input_hash,status,attempts,artifact_ref) values(workspace,refresh,'quality_final',repeat('a',64),'completed',1,repeat('b',64));
 content:=content||jsonb_build_object('revision',2,'body','Updated and reviewed evidence','approvedHash',null,'generationEvidenceRunId',refresh);
 begin
  perform public.studio_commit_researched_article(workspace,refresh,gen_random_uuid(),content);
  raise exception 'Missing stale refresh lease rejection';
 exception when others then if sqlerrm='Missing stale refresh lease rejection' then raise; end if; end;
 saved:=public.studio_commit_researched_article(workspace,refresh,token,content);
 if (saved->>'revision')::integer<>2 or saved->'approvedHash'<>'null'::jsonb then raise exception 'Refresh did not create an unapproved revision'; end if;
 if public.studio_commit_researched_article(workspace,refresh,token,content)<>saved then raise exception 'Refresh replay created another revision'; end if;
 update public.studio_task_runs set status='succeeded',draft_id=original where id=refresh;
 second:=public.studio_request_evidence_refresh(workspace,original,2,'source_changed');
 update public.studio_task_runs set status='researching',lease_token=token,lease_expires_at=now()+interval '5 minutes' where id=second;
 insert into public.studio_research_steps(workspace_id,run_id,stage,input_hash,status,attempts,artifact_ref) values(workspace,second,'quality_final',repeat('a',64),'completed',1,repeat('b',64));
 perform public.studio_commit_article(workspace,gen_random_uuid(),2,content||'{"revision":3,"body":"Owner edit"}'::jsonb);
 begin
  perform public.studio_commit_researched_article(workspace,second,token,content||jsonb_build_object('revision',3,'generationEvidenceRunId',second));
  raise exception 'Refresh overwrote an owner edit';
 exception when others then if sqlerrm='Refresh overwrote an owner edit' then raise; end if; end;
 if (select count(*) from public.studio_revisions where workspace_id=workspace and draft_id=original)<>3 then raise exception 'Unexpected article revision count'; end if;
 raise notice 'Evidence refresh idempotency, revision binding, lease fencing and owner-edit preservation passed';
end $$;
