-- Execute after migration 016 against the isolated Docker Supabase; all fixtures roll back.
-- This fixture uses a random workspace and never invokes generation or delivery.
begin;
do $$
declare
  workspace uuid:=gen_random_uuid(); wrong_workspace uuid:=gen_random_uuid(); task_id uuid:=gen_random_uuid(); parent_id uuid:=gen_random_uuid();
  source jsonb:=jsonb_build_object('title','Fixture source','url','https://example.org/software','excerpt','Verified test fixture evidence, not a real researched article.');
  question jsonb:=jsonb_build_object('question','Useful software question?','audienceNeed','Help software users.','angle','Practical explanation.','sourceUrls',jsonb_build_array('https://example.org/software'),'platforms',jsonb_build_array('x'),'assessment',jsonb_build_object('status','allowed','reasons',jsonb_build_array('Fixture assessment.')));
  parent_config jsonb; child_config jsonb; first public.studio_discovery_promotions; repeated public.studio_discovery_promotions; second public.studio_discovery_promotions;
  child public.studio_tasks; child_run public.studio_task_runs; before_messages bigint; after_messages bigint; before_tasks bigint; denied boolean;
begin
  parent_config:=jsonb_build_object('title','Discovery SQL fixture','prompt','Find useful software topics.','audience','','angle','','model','fixture-model','platforms',jsonb_build_array('x','reddit'),'sources','[]'::jsonb,'assetIds','[]'::jsonb,'knowledgeIds',jsonb_build_array(gen_random_uuid()),'kind','discovery','topicOrigin','editorial','frequency',jsonb_build_object('type','daily','time','09:00','timezone','Asia/Singapore'),'enabled',true,'discoveryAutomation',jsonb_build_object('enabled',true,'maxDrafts',2));
  child_config:=parent_config||jsonb_build_object('title',question->>'question','prompt',(question->>'question')||E'\n\nAudience need: '||(question->>'audienceNeed')||E'\nRequested angle: '||(question->>'angle')||E'\nResearch the verified sources in depth and generate reviewable master content and destination-specific versions.','audience',question->>'audienceNeed','angle',question->>'angle','platforms',question->'platforms','sources',jsonb_build_array(source),'kind','content','topicOrigin','trend','frequency',jsonb_build_object('type','once','time','09:00','timezone','Asia/Singapore'),'discoveryAutomation',jsonb_build_object('enabled',false,'maxDrafts',1));
  insert into public.studio_tasks(id,workspace_id,config,next_run_at) values(task_id,workspace,parent_config,now()+interval '1 day');
  insert into public.studio_task_runs(id,workspace_id,task_id,slot,task_snapshot,status,sources,questions)
    values(parent_id,workspace,task_id,'sql-automation-fixture',parent_config||jsonb_build_object('id',task_id,'createdAt',now(),'updatedAt',now(),'nextRunAt',now()+interval '1 day'),'succeeded',jsonb_build_array(source),jsonb_build_array(question,question||jsonb_build_object('question','Another useful software question?'),question||jsonb_build_object('question','Third useful software question?')));

  denied:=false;
  begin perform public.studio_promote_discovery_candidate(wrong_workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Workspace mismatch was accepted'; end if;
  update public.studio_task_runs set status='queued' where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Unfinished parent was accepted'; end if;
  update public.studio_task_runs set status='succeeded',task_snapshot=jsonb_set(task_snapshot,'{discoveryAutomation,enabled}','false') where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Disabled automation was accepted'; end if;
  update public.studio_task_runs set task_snapshot=jsonb_set(task_snapshot,'{discoveryAutomation,enabled}','true') where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,2,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Selection cap was bypassed'; end if;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config||jsonb_build_object('prompt','Client injected unverified task prompt.')); exception when others then denied:=true; end;
  if not denied then raise exception 'Client-supplied task was trusted'; end if;
  update public.studio_task_runs set sources='[]'::jsonb where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Unverified source was accepted'; end if;
  update public.studio_task_runs set sources=jsonb_build_array(source),questions=jsonb_set(questions,'{0,platforms}',jsonb_build_array('youtube')) where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Unsupported platform was accepted'; end if;
  update public.studio_task_runs set questions=jsonb_set(questions,'{0}',question) where id=parent_id;
  update public.studio_task_runs set questions=jsonb_set(questions,'{0,assessment,status}','"uncertain"'::jsonb) where id=parent_id;
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when others then denied:=true; end;
  if not denied then raise exception 'Uncertain candidate was accepted'; end if;
  update public.studio_task_runs set questions=jsonb_set(questions,'{0}',question) where id=parent_id;

  -- Force a failure after the child/run/message inserts to prove the RPC rolls all of them back.
  alter table public.studio_discovery_promotions add constraint fixture_reject_first_candidate check(candidate_index<>0);
  denied:=false;
  begin perform public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config); exception when check_violation then denied:=true; end;
  if not denied then raise exception 'Atomic-rollback injection did not run'; end if;
  alter table public.studio_discovery_promotions drop constraint fixture_reject_first_candidate;
  if exists(select 1 from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text) or exists(select 1 from public.studio_task_runs where workspace_id=workspace and id<>parent_id) then raise exception 'Failed promotion left a child run or queue message'; end if;
  select count(*) into before_tasks from public.studio_tasks where workspace_id=workspace;
  if before_tasks<>1 then raise exception 'Rejected RPC left orphan tasks'; end if;
  select count(*) into before_messages from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text;
  first:=public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config);
  repeated:=public.studio_promote_discovery_candidate(workspace,parent_id,0,child_config);
  if first.id<>repeated.id or first.child_task_id<>repeated.child_task_id or first.child_run_id<>repeated.child_run_id then raise exception 'Repeat created another promotion'; end if;
  select count(*) into after_messages from pgmq.q_studio_jobs where message->>'workspaceId'=workspace::text;
  if after_messages<>before_messages+1 then raise exception 'Promotion queue delivery is missing or duplicated'; end if;
  select * into child from public.studio_tasks where id=first.child_task_id;
  select * into child_run from public.studio_task_runs where id=first.child_run_id;
  if child.next_run_at is not null or child.config->>'kind'<>'content' or child.config->>'topicOrigin'<>'trend' or child.config#>>'{frequency,type}'<>'once' or child.config#>'{discoveryAutomation,enabled}'<>'false'::jsonb then raise exception 'Child recursion or schedule was armed'; end if;
  if child.config->'knowledgeIds'<>parent_config->'knowledgeIds' or child.config->'model'<>parent_config->'model' or child.config->'sources'<>jsonb_build_array(source) then raise exception 'Frozen context was lost'; end if;
  if child_run.status<>'queued' or child_run.task_snapshot->'knowledgeIds'<>child.config->'knowledgeIds' or child_run.task_snapshot->>'nextRunAt' is not null then raise exception 'Queued snapshot is not frozen'; end if;
  -- An edited schedule cannot alter the completed snapshot's promotion authority.
  update public.studio_tasks set config=jsonb_set(config,'{discoveryAutomation,enabled}','false') where id=task_id;
  question:=question||jsonb_build_object('question','Another useful software question?');
  child_config:=child_config||jsonb_build_object('title',question->>'question','prompt',(question->>'question')||E'\n\nAudience need: '||(question->>'audienceNeed')||E'\nRequested angle: '||(question->>'angle')||E'\nResearch the verified sources in depth and generate reviewable master content and destination-specific versions.');
  second:=public.studio_promote_discovery_candidate(workspace,parent_id,1,child_config);
  if first.child_run_id=second.child_run_id then raise exception 'Distinct candidate reused a child'; end if;
  perform public.studio_dispatch_due_tasks(workspace);
  if (select count(*) from public.studio_task_runs where workspace_id=workspace)<>3 then raise exception 'Once child was dispatched a second time'; end if;
  if (select count(*) from public.studio_discovery_promotions where workspace_id=workspace)<>2 then raise exception 'Promotion relationship cap is wrong'; end if;
  if public.studio_task_label(repeat('Q',199)||'😀suffix',200)<>repeat('Q',199) then raise exception 'UTF-16 label boundary mismatch'; end if;
  if public.studio_task_trim(U&'\00A0trimmed\FEFF')<>'trimmed' then raise exception 'ECMAScript whitespace trim mismatch'; end if;
  raise notice 'PASS isolated discovery automation: authority checks, cap, atomic queue, duplicate repair, frozen context, once/no recursion';
end $$;
rollback;
