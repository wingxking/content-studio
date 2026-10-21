-- Run inside a rollback-only transaction with the pending migration.
do $$
declare w uuid:=gen_random_uuid(); t uuid:=gen_random_uuid(); original uuid:=gen_random_uuid(); refresh uuid:=gen_random_uuid(); cloned uuid:=gen_random_uuid(); clone_run uuid:=gen_random_uuid(); discovery uuid:=gen_random_uuid(); discovery_run uuid:=gen_random_uuid(); child uuid:=gen_random_uuid(); child_run uuid:=gen_random_uuid(); article jsonb; config jsonb; batch uuid:=gen_random_uuid(); claim jsonb; item uuid;
begin
 insert into public.content_studio_workspaces(id,state) values(w,jsonb_build_object('version',1,'paused',true,'accounts','[]'::jsonb,'drafts','[]'::jsonb,'jobs','[]'::jsonb));
 config:=jsonb_build_object('title','Workbench fixture','kind','content','enabled',false,'frequency',jsonb_build_object('type','once','time','09:00','timezone','Asia/Singapore'));
 insert into public.studio_tasks(id,workspace_id,config) values(t,w,config),(cloned,w,config),(discovery,w,config||'{"kind":"discovery"}'),(child,w,config);
 article:=jsonb_build_object('id',original,'revision',2,'createdAt',now(),'title','Stable episode','body','fixture','variants','[]'::jsonb,'approvedHash',null);
 update public.content_studio_workspaces set state=jsonb_set(state,'{drafts}',jsonb_build_array(article,jsonb_set(article,'{id}',to_jsonb(clone_run)),jsonb_set(article,'{id}',to_jsonb(child_run)))) where id=w;
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,draft_id,created_at) values(original,w,t,'original',config,'succeeded',original,now()-interval '2 days');
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,draft_id,refresh_draft_id,refresh_revision,refresh_reason,created_at) values(refresh,w,t,'refresh',config,'succeeded',original,original,1,'review_requested',now());
 assert (select origin_run_id=original from public.studio_article_origins where workspace_id=w and draft_id=original),'Refresh replaced the original episode';
 assert jsonb_array_length(public.studio_list_content(w,'article',null,t,original))=1,'Original episode lost refreshed content';
 assert jsonb_array_length(public.studio_list_content(w,'article',null,t,refresh))=0,'Refresh became a duplicate episode';
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,draft_id) values(clone_run,w,cloned,'cloned',config||jsonb_build_object('sourceRunId',original),'succeeded',clone_run);
 insert into public.studio_task_links values(w,t,original,cloned,'cloned_from',null);
 assert jsonb_array_length(public.studio_list_content(w,'article',null,t))=1,'Independent clone leaked into the original task';
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status) values(discovery_run,w,discovery,'discovery',config||'{"kind":"discovery"}','succeeded');
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,draft_id) values(child_run,w,child,'child',config,'succeeded',child_run);
 insert into public.studio_task_links values(w,discovery,discovery_run,child,'question_derived',0);
 assert jsonb_array_length(public.studio_list_content(w,'article',null,discovery,discovery_run))=1,'Discovery lost its derived content';
 assert jsonb_array_length(public.studio_task_index(w))=3,'Index must group derived children and retain independent clones';
 assert jsonb_array_length(public.studio_task_index(gen_random_uuid()))=0,'Cross-workspace index leak';
 perform set_config('studio.workbench_fixture',w::text,true);perform set_config('studio.workbench_batch',batch::text,true);
 assert not has_table_privilege('anon','public.studio_library_entries','select'),'Anonymous library access';
 assert not has_function_privilege('authenticated','public.studio_create_delivery_batch(uuid,uuid,text,jsonb)','execute'),'Client batch RPC access';
 assert (public.studio_article_detail(w,original)->'draft'->>'revision')::integer=2,'Targeted article detail lost revision';
end $$;
set local role service_role;
do $$
declare w uuid:=current_setting('studio.workbench_fixture')::uuid; b uuid:=current_setting('studio.workbench_batch')::uuid; payload jsonb; claim jsonb; item uuid;
begin
 payload:=jsonb_build_array(jsonb_build_object('fixture',true));
 perform public.studio_create_delivery_batch(w,b,repeat('a',64),payload);
 perform public.studio_create_delivery_batch(w,b,repeat('a',64),payload);
 assert (select count(*)=1 from public.studio_delivery_batch_items where workspace_id=w and batch_id=b),'Batch replay duplicated items';
 begin
  perform public.studio_create_delivery_batch(w,b,repeat('b',64),payload);raise exception 'Changed command accepted';
 exception when others then if sqlerrm='Changed command accepted' then raise;end if;end;
end $$;
reset role;
update pgmq.q_studio_jobs set vt=now() where message->>'workspaceId'=current_setting('studio.workbench_fixture');
set local role service_role;
do $$
declare w uuid:=current_setting('studio.workbench_fixture')::uuid; claim jsonb; item uuid;
begin
 claim:=public.studio_claim_role_work(w,'delivery');assert claim is not null,'Delivery role cannot claim a batch item';item:=(claim#>>'{message,id}')::uuid;
 begin
  perform public.studio_bind_batch_job(w,item,gen_random_uuid(),gen_random_uuid());raise exception 'Stale lease accepted';
 exception when others then if sqlerrm='Stale lease accepted' then raise;end if;end;
 perform public.studio_finish_batch_item(w,item,(claim->>'token')::uuid,null,'Known blocked target');
 assert (select status='blocked' from public.studio_delivery_batch_items where id=item),'Blocked batch result not durable';
end $$;
reset role;
