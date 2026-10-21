-- Execute migration 025 and this test in one rollback-only transaction.
do $$
declare workspace uuid:=gen_random_uuid(); command uuid:=gen_random_uuid(); config jsonb; first_grant jsonb; result public.studio_tasks;
begin
 insert into public.content_studio_workspaces(id,state) values(workspace,jsonb_build_object('version',1,'paused',true,'accounts','[]'::jsonb,'drafts','[]'::jsonb,'jobs','[]'::jsonb));
 first_grant:=jsonb_build_object('id',gen_random_uuid(),'configHash',repeat('a',64),'createdAt',now(),'accounts','[]'::jsonb);
 config:=jsonb_build_object('title','Grant replay fixture','enabled',false,'frequency',jsonb_build_object('type','once','time','09:00','timezone','UTC'),'authorization',first_grant);
 result:=public.studio_create_task(workspace,command,config);
 assert result.config->'authorization'=first_grant,'First server grant missing';
 result:=public.studio_create_task(workspace,command,jsonb_set(config,'{authorization,id}',to_jsonb(gen_random_uuid())));
 assert result.config->'authorization'=first_grant,'Replay replaced the original grant';
 begin
  perform public.studio_create_task(workspace,command,jsonb_set(config,'{title}','"Different topic"'));
  raise exception 'Different operator input accepted';
 exception when others then if sqlerrm='Different operator input accepted' then raise; end if; end;
 result:=public.studio_save_task(workspace,command,config-'authorization');
 assert not (result.config ? 'authorization'),'Revoked grant survived task save';
end $$;
