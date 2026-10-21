-- Accepted master proposals and ordinary saves share atomic follow-up creation.
create or replace function public.studio_record_article_revision() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare draft jsonb; previous jsonb; stored jsonb; operation uuid;
begin
  for draft in select value from jsonb_array_elements(coalesce(new.state->'drafts','[]'::jsonb)) loop
    select value into previous from jsonb_array_elements(coalesce(old.state->'drafts','[]'::jsonb)) where value->>'id'=draft->>'id';
    if previous is not null and previous->'revision'=draft->'revision' then continue; end if;
    if previous is not null then
      insert into public.studio_revisions(draft_id,workspace_id,revision,content)
      values((previous->>'id')::uuid,new.id,(previous->>'revision')::integer,previous) on conflict(draft_id,revision) do nothing;
    end if;
    select content into stored from public.studio_revisions where draft_id=(draft->>'id')::uuid and revision=(draft->>'revision')::integer;
    if stored is not null and (stored-'approvedHash') is distinct from (draft-'approvedHash') then raise exception 'Immutable article revision conflict'; end if;
    insert into public.studio_revisions(draft_id,workspace_id,revision,content)
    values((draft->>'id')::uuid,new.id,(draft->>'revision')::integer,draft) on conflict(draft_id,revision) do nothing;
    if draft->>'adaptationStatus'='pending' then
      perform public.studio_create_operation(new.id,gen_random_uuid(),(draft->>'id')::uuid,'sync',jsonb_strip_nulls(jsonb_build_object(
        'expectedRevision',(draft->>'revision')::integer,'model',draft->>'generationModel',
        'generationInstruction',draft->'generationInstruction','assetIds',draft->'generationAssetIds','generationKnowledgeRef',draft->'generationKnowledgeRef')));
    end if;
    operation:=gen_random_uuid();
    insert into public.studio_operations(id,workspace_id,draft_id,subject_kind,subject_id,kind,input)
    values(operation,new.id,(draft->>'id')::uuid,'article',(draft->>'id')::uuid,'article_export',jsonb_build_object('expectedRevision',(draft->>'revision')::integer,'exporterVersion',1));
    perform public.studio_enqueue_work(new.id,'studio_operation',operation);
  end loop;
  return new;
end $$;

notify pgrst,'reload schema';
