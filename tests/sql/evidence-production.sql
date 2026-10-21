-- Run after migration 026 in a BEGIN/ROLLBACK transaction. No real workspace writes persist.
do $$
declare workspace uuid:=gen_random_uuid(); task uuid:=gen_random_uuid(); run uuid:=gen_random_uuid(); token uuid:=gen_random_uuid(); doc text:=repeat('a',64); result jsonb; count_value integer; message_id bigint; item integer; document_key text;
begin
 insert into public.content_studio_workspaces(id,state) values(workspace,'{"paused":true,"accounts":[],"drafts":[],"jobs":[]}'::jsonb);
 insert into public.studio_tasks(id,workspace_id,config) values(task,workspace,'{}');
 insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,lease_token,lease_expires_at) values(run,workspace,task,'fixture','{"pipelineVersion":2,"kind":"content"}','researching',token,now()+interval '5 minutes');
 result:=public.studio_research_step(workspace,run,token,'research_plan',repeat('b',64),'fixture',null,1);
 if result->>'status'<>'running' then raise exception 'Missing research intent'; end if;
 perform public.studio_research_step(workspace,run,token,'research_plan',repeat('b',64),'fixture',repeat('c',64),1);
 result:=public.studio_research_step(workspace,run,token,'research_plan',repeat('b',64),'fixture',null,1);
 if result->>'status'<>'completed' or (result->>'attempts')::integer<>1 then raise exception 'Completed step replay dispatched another attempt'; end if;
 begin
  perform public.studio_research_step(workspace,run,token,'research_extra',repeat('d',64),'fixture',null,1);
  raise exception 'Missing budget rejection';
 exception when others then if sqlerrm='Missing budget rejection' then raise; end if; end;
 begin
  perform public.studio_research_step(workspace,run,gen_random_uuid(),'writer',repeat('e',64),'fixture');
  raise exception 'Missing ownership rejection';
 exception when others then if sqlerrm='Missing ownership rejection' then raise; end if; end;
 perform public.studio_research_step(workspace,run,token,'evidence_bundle',repeat('e',64),null,null,1);
 perform public.studio_research_step(workspace,run,token,'evidence_bundle',repeat('e',64),null,repeat('f',64),1);
 perform public.studio_research_step(workspace,run,token,'variant_zhihu_adapt',repeat('e',64),'fixture',null,2);
 perform public.studio_research_step(workspace,run,token,'variant_zhihu_adapt',repeat('e',64),'fixture',repeat('f',64),2);
 perform public.studio_research_step(workspace,run,token,'variant_zhihu_check',repeat('e',64),'fixture',null,2);
 result:=public.studio_research_step(workspace,run,token,'variant_zhihu_check',repeat('e',64),'fixture',null,2,'{"cost":null,"outcome":"interrupted"}');
 if (result->>'attempts')::integer<>1 or result->'usage'->>'outcome'<>'interrupted' then raise exception 'Failure accounting consumed an extra model call'; end if;
 result:=public.studio_research_step(workspace,run,token,'variant_zhihu_check',repeat('e',64),'fixture',null,3);
 if (result->>'attempts')::integer<>2 or jsonb_array_length(result->'attempt_metrics')<>1 then raise exception 'Lost prior attempt metrics'; end if;
 result:=public.studio_production_metrics(workspace);
 if result#>>'{model,confirmedCost}' is not null or result#>>'{sources,failureRate}' is not null then raise exception 'Unknown cost/rate was presented as zero'; end if;
 begin
  perform public.studio_commit_researched_article(workspace,run,gen_random_uuid(),'{}');
  raise exception 'Missing stale article commit rejection';
 exception when others then if sqlerrm='Missing stale article commit rejection' then raise; end if; end;
 insert into public.studio_evidence_documents(workspace_id,id,metadata) values(workspace,doc,'{"immutable":true}');
 insert into public.studio_evidence_chunks(workspace_id,document_id,id,metadata,keywords,embedding,embedding_version)
 values(workspace,doc,'chunk-fixture','{}',to_tsvector('simple','软件 备份 版本 恢复'),array_fill(0.01::real,array[384])::extensions.vector,'fixture');
 select count(*) into count_value from public.studio_evidence_search(workspace,'备份 恢复',array_fill(0.01::real,array[384])::extensions.vector,10,'fixture');
 if count_value<>1 then raise exception 'Hybrid Chinese retrieval failed'; end if;
 select count(*) into count_value from public.studio_evidence_search(gen_random_uuid(),'备份 恢复',array_fill(0.01::real,array[384])::extensions.vector,10,'fixture');
 if count_value<>0 then raise exception 'Evidence leaked across workspace'; end if;
 insert into public.studio_evidence_documents(workspace_id,id,metadata) values
 (workspace,repeat('1',64),'{"url":"https://fixture.invalid/original","originHash":"same-body","category":"primary","access":"full","fetchedAt":"2026-10-17T00:00:00Z"}'),
 (workspace,repeat('2',64),'{"url":"https://fixture.invalid/reprint","originHash":"same-body","category":"media","access":"full","fetchedAt":"2026-10-17T01:00:00Z"}'),
 (workspace,repeat('3',64),'{"url":"https://fixture.invalid/original","originHash":"old-body","category":"primary","access":"full","fetchedAt":"2026-10-16T00:00:00Z"}');
 insert into public.studio_evidence_chunks(workspace_id,document_id,id,metadata,keywords)
 values(workspace,repeat('1',64),'original-new','{}',to_tsvector('simple','去重 新版')),
 (workspace,repeat('2',64),'syndicated-copy','{}',to_tsvector('simple','去重 新版')),
 (workspace,repeat('3',64),'original-old','{}',to_tsvector('simple','过期旧版'));
 select count(*) into count_value from public.studio_evidence_search(workspace,'去重',null,10);
 if count_value<>1 or not exists(select 1 from public.studio_evidence_search(workspace,'去重',null,10) where document_id=repeat('1',64)) then raise exception 'Syndication deduplication lost the original source'; end if;
 select count(*) into count_value from public.studio_evidence_search(workspace,'过期旧版',null,10);
 if count_value<>0 then raise exception 'Obsolete source snapshot leaked into current retrieval'; end if;
 for item in 1..12 loop
  document_key:=md5(item::text)||md5(item::text);
  insert into public.studio_evidence_documents(workspace_id,id,metadata) values(workspace,document_key,'{}');
  insert into public.studio_evidence_chunks(workspace_id,document_id,id,metadata,keywords) values(workspace,document_key,'mixed-'||item::text,'{}',to_tsvector('simple','fixture revision 编辑 还原 以前 文稿'));
 end loop;
 insert into public.studio_evidence_documents(workspace_id,id,metadata) values(workspace,repeat('9',64),'{}');
 insert into public.studio_evidence_chunks(workspace_id,document_id,id,metadata,keywords) values(workspace,repeat('9',64),'foreign-original','{}',to_tsvector('simple','fixture revision immutable bytes restoration'));
 if not exists(select 1 from public.studio_evidence_search(workspace,'fixture revision 编辑 还原 以前 文稿',null,10) where document_id=repeat('9',64)) then raise exception 'Mixed-language retrieval lost a matching foreign original'; end if;
 if has_table_privilege('anon','public.studio_evidence_documents','select') then raise exception 'Anonymous evidence access'; end if;
 message_id:=public.studio_enqueue_work(workspace,'task_run',run);
 update pgmq.q_studio_jobs set vt=now()-interval '1 second' where msg_id=message_id;
 result:=public.studio_claim_role_work(workspace,'article');
 if result is null or (result->>'msgId')::bigint is distinct from message_id then raise exception 'Unexpected queued research message'; end if;
 token:=(result->>'token')::uuid;
 update public.studio_task_runs set lease_token=token where id=run;
 if public.studio_defer_research(workspace,run,gen_random_uuid(),1800,'quota') then raise exception 'Stale owner deferred research'; end if;
 if not public.studio_defer_research(workspace,run,token,1800,'quota') then raise exception 'Research defer failed'; end if;
 if not exists(select 1 from pgmq.q_studio_jobs where msg_id=message_id and vt>now()+interval '29 minutes') then raise exception 'Quota wait was not durable'; end if;
 if exists(select 1 from public.studio_queue_leases where msg_id=message_id) then raise exception 'Deferred research retained active ownership'; end if;
 if not exists(select 1 from public.studio_task_runs where id=run and status='queued' and phase='waiting_quota') then raise exception 'Quota wait lost its run identity'; end if;
 insert into public.studio_source_registry(workspace_id,id,config) values(workspace,'fixture',jsonb_build_object('enabled',true,'access','readable','intervalMinutes',60));
 perform public.studio_queue_source(workspace,'fixture','manual:stable');
 perform public.studio_queue_source(workspace,'fixture','manual:stable');
 select count(*) into count_value from public.studio_source_collections where workspace_id=workspace;
 if count_value<>1 then raise exception 'Duplicate source collection'; end if;
 if not exists(select 1 from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text and message->>'type'='source_collect') then raise exception 'Missing durable source collection'; end if;
 raise notice 'evidence gates, lease fencing, call budgets, hybrid retrieval, workspace isolation and source idempotency passed';
end $$;
