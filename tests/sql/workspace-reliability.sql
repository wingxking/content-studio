-- Execute after pending migrations inside a rollback-only transaction.
do $$
declare workspace uuid:=gen_random_uuid(); article uuid:=gen_random_uuid(); command uuid:=gen_random_uuid(); saved jsonb; original jsonb; count_before integer; task uuid:=gen_random_uuid(); config jsonb; row public.studio_tasks; parent_task uuid:=gen_random_uuid(); parent_run uuid; child_task uuid:=gen_random_uuid(); child_run uuid;
begin
 insert into public.content_studio_workspaces(id,state) values(workspace,jsonb_build_object('version',1,'paused',true,'accounts','[]'::jsonb,'drafts','[]'::jsonb,'jobs','[]'::jsonb));
 original:=jsonb_build_object('id',article,'revision',1,'createdAt',now(),'title','Reliability fixture','body','Evidence','brief',jsonb_build_object('sources','[]'::jsonb),'variants',jsonb_build_array(jsonb_build_object('platform','x','title','Fixture','text','Evidence','tags','[]'::jsonb,'mediaPaths','[]'::jsonb),jsonb_build_object('platform','reddit','title','Fixture','text','Evidence','tags','[]'::jsonb,'mediaPaths','[]'::jsonb)),'approvedHash',null);
 saved:=public.studio_commit_article(workspace,command,0,original);
 assert saved=original,'Commit changed content';
 assert (select count(*)=1 from public.studio_revisions where workspace_id=workspace and draft_id=article),'Missing immutable revision';
 assert (select count(*)=1 from public.studio_operations where workspace_id=workspace and kind='article_export'),'Missing durable export';
 saved:=public.studio_commit_article(workspace,command,0,original);
 assert saved=original,'Replay changed content';
 assert (select count(*)=1 from public.studio_revisions where workspace_id=workspace and draft_id=article),'Replay duplicated revision';
 begin
  perform public.studio_commit_article(workspace,command,0,jsonb_set(original,'{title}','"Different"'));
  raise exception 'Different command payload accepted';
 exception when others then if sqlerrm='Different command payload accepted' then raise; end if; end;
 saved:=public.studio_commit_article(workspace,gen_random_uuid(),1,jsonb_set(jsonb_set(original,'{revision}','2'),'{title}','"Revision two"'));
 assert (saved->>'revision')::integer=2,'Next revision missing';
 assert (select count(*)=2 from public.studio_revisions where workspace_id=workspace and draft_id=article),'History lost';
 assert jsonb_array_length(public.studio_list_content(workspace,'article','x'))=1,'Content projection missing';
 assert jsonb_array_length(public.studio_list_content(workspace,'video','x'))=0,'Content filter failed';
 update public.content_studio_workspaces set state=jsonb_set(state,'{jobs}',jsonb_build_array(jsonb_build_object('draftId',article,'platform','x','status','published','createdAt',now()))) where id=workspace;
 assert jsonb_array_length(public.studio_list_content(workspace,'article','x',null,null,'published'))=1,'Published platform missing';
 assert jsonb_array_length(public.studio_list_content(workspace,'article','reddit',null,null,'published'))=0,'Other platform publication leaked';
 assert jsonb_array_length(public.studio_list_content(workspace,'article','reddit',null,null,'generated'))=1,'Generation history lost';
 config:=jsonb_build_object('title','Once fixture','kind','content','enabled',false,'frequency',jsonb_build_object('type','once','time','09:00','timezone','UTC'));
 row:=public.studio_create_task(workspace,task,config);
 row:=public.studio_create_task(workspace,task,config);
 assert (select count(*)=1 from public.studio_tasks where workspace_id=workspace),'Task replay duplicated';
 assert row.config_version=1,'Task replay mutated configuration';
 perform public.studio_create_task(workspace,parent_task,config||jsonb_build_object('kind','discovery'));
 parent_run:=(public.studio_enqueue_task_run(workspace,parent_task,'manual:'||gen_random_uuid()::text)).id;
 update public.studio_task_runs set status='succeeded' where id=parent_run;
 perform public.studio_create_task(workspace,child_task,config||jsonb_build_object('sourceRunId',parent_run));
 child_run:=(public.studio_enqueue_task_run(workspace,child_task,'manual:'||gen_random_uuid()::text)).id;
 update public.studio_task_runs set status='succeeded',draft_id=article where id=child_run;
 assert jsonb_array_length(public.studio_list_content(workspace,'article',null,parent_task))=1,'Discovery task batch lost';
 assert jsonb_array_length(public.studio_list_content(workspace,'article',null,null,parent_run))=1,'Explicit question child lost from batch';
 -- Reviewed proposals use the same transactional trigger and cannot leave a pending master without work.
 declare proposal uuid:=gen_random_uuid(); proposed jsonb;
 begin
  proposed:=jsonb_build_object('title',saved->>'title','body','Reviewed master proposal','variants',saved->'variants');
  insert into public.studio_operations(id,workspace_id,draft_id,kind,status,input,output) values(proposal,workspace,article,'refine','succeeded',jsonb_build_object('expectedRevision',2,'model','reviewed-fixture-model'),jsonb_build_object('proposal',proposed,'applied',false));
  saved:=public.studio_apply_proposal(workspace,proposal,article,2,proposed);
  assert (saved->>'revision')::integer=3,'Proposal lost revision';
  assert saved->>'generationModel'='reviewed-fixture-model','Proposal lost selected model';
  assert (select count(*)=1 from public.studio_operations where workspace_id=workspace and draft_id=article and kind='sync' and input->>'expectedRevision'='3'),'Proposal follow-up not atomic';
  assert (select input->>'model'='reviewed-fixture-model' from public.studio_operations where workspace_id=workspace and draft_id=article and kind='sync' and input->>'expectedRevision'='3'),'Proposal adaptation lost selected model';
  perform public.studio_apply_proposal(workspace,proposal,article,2,proposed);
  assert (select count(*)=1 from public.studio_operations where workspace_id=workspace and draft_id=article and kind='sync' and input->>'expectedRevision'='3'),'Proposal replay duplicated follow-up';
 end;
 select count(*) into count_before from public.studio_operations where workspace_id=workspace;
 perform public.studio_workspace_summary(workspace); perform public.studio_list_content(workspace);
 assert (select count(*)=count_before from public.studio_operations where workspace_id=workspace),'Read created work';
end $$;
