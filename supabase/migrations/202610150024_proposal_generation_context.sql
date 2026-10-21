-- Keep the reviewed payload byte-for-byte comparable and inherit its selected model
-- inside the same transaction that creates the next revision and adaptation work.
create or replace function public.studio_apply_proposal(p_workspace uuid,p_operation uuid,p_draft uuid,p_expected_revision integer,p_content jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare workspace_row public.content_studio_workspaces%rowtype; operation_row public.studio_operations%rowtype;
  draft jsonb; updated_draft jsonb; draft_index integer;
begin
  select * into workspace_row from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  select * into operation_row from public.studio_operations where id=p_operation and workspace_id=p_workspace and draft_id=p_draft for update;
  if not found or operation_row.status<>'succeeded' or operation_row.kind not in ('refine','sync') then
    raise exception 'The proposal is cancelled, incomplete, or unavailable';
  end if;
  select value,(ordinality-1)::integer into draft,draft_index
    from jsonb_array_elements(workspace_row.state->'drafts') with ordinality where value->>'id'=p_draft::text;
  if draft is null then raise exception 'Draft not found'; end if;
  if coalesce((operation_row.output->>'applied')::boolean,false) or draft->>'lastAppliedProposalId'=p_operation::text then
    update public.studio_operations set output=jsonb_set(output,'{applied}','true'::jsonb),updated_at=now() where id=p_operation;
    return draft;
  end if;
  if p_expected_revision is null or p_expected_revision<1 or (operation_row.input->>'expectedRevision')::integer is distinct from p_expected_revision or (draft->>'revision')::integer is distinct from p_expected_revision then
    raise exception 'The draft changed after this proposal was generated';
  end if;
  if p_content is distinct from operation_row.output->'proposal' then raise exception 'The reviewed proposal content does not match'; end if;
  if exists(select 1 from jsonb_array_elements(workspace_row.state->'jobs') where value->>'draftId'=p_draft::text and value->>'status'='submitting') then
    raise exception 'Reconcile the active publication before editing';
  end if;
  updated_draft:=(draft-'lastOperationId')||p_content||jsonb_build_object('revision',p_expected_revision+1,'approvedHash',null,'lastAppliedProposalId',p_operation);
  if jsonb_typeof(operation_row.input->'model')='string' and operation_row.input->>'model' ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$' then
    updated_draft:=updated_draft||jsonb_build_object('generationModel',operation_row.input->>'model');
  end if;
  if draft->>'title' is distinct from p_content->>'title' or draft->>'body' is distinct from p_content->>'body'
     or (p_content ? 'document' and draft->'document' is distinct from p_content->'document') then
    updated_draft:=updated_draft||jsonb_build_object('adaptationStatus','pending');
  end if;
  insert into public.studio_revisions(draft_id,workspace_id,revision,content)
    values(p_draft,p_workspace,p_expected_revision,draft),(p_draft,p_workspace,p_expected_revision+1,updated_draft)
    on conflict(draft_id,revision) do nothing;
  update public.content_studio_workspaces set state=jsonb_set(workspace_row.state,array['drafts',draft_index::text],updated_draft),revision=workspace_row.revision+1,updated_at=now() where id=p_workspace;
  update public.studio_operations set output=jsonb_set(output,'{applied}','true'::jsonb),updated_at=now() where id=p_operation;
  return updated_draft;
end $$;
revoke all on function public.studio_apply_proposal(uuid,uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_apply_proposal(uuid,uuid,uuid,integer,jsonb) to service_role;

notify pgrst,'reload schema';
