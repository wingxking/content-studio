create table public.studio_assets (
  id uuid primary key,
  workspace_id uuid not null references public.content_studio_workspaces(id),
  name text not null,
  mime text not null,
  bytes bigint not null check (bytes > 0),
  sha256 text not null,
  object_key text not null unique,
  created_at timestamptz not null default now()
);
create index studio_assets_workspace_created on public.studio_assets(workspace_id, created_at desc);

create table public.studio_editor_state (
  draft_id uuid primary key,
  workspace_id uuid not null references public.content_studio_workspaces(id),
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create table public.studio_revisions (
  draft_id uuid not null,
  workspace_id uuid not null references public.content_studio_workspaces(id),
  revision integer not null,
  content jsonb not null,
  created_at timestamptz not null default now(),
  primary key (draft_id, revision)
);
create table public.studio_operations (
  id uuid primary key,
  workspace_id uuid not null references public.content_studio_workspaces(id),
  draft_id uuid not null,
  kind text not null check (kind in ('sync','refine','video_script','video_render','publish')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  phase text not null default 'Waiting for worker',
  input jsonb not null,
  output jsonb,
  error text,
  owner_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index studio_operations_workspace on public.studio_operations(workspace_id, draft_id, created_at desc);
create table public.studio_videos (
  id uuid primary key,
  workspace_id uuid not null references public.content_studio_workspaces(id),
  draft_id uuid not null,
  state jsonb not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_assets enable row level security;
alter table public.studio_editor_state enable row level security;
alter table public.studio_revisions enable row level security;
alter table public.studio_operations enable row level security;
alter table public.studio_videos enable row level security;
revoke all on public.studio_assets,public.studio_editor_state,public.studio_revisions,public.studio_operations,public.studio_videos from anon,authenticated;
grant all on public.studio_assets,public.studio_editor_state,public.studio_revisions,public.studio_operations,public.studio_videos to service_role;

create or replace function public.studio_save_editor_state(p_workspace uuid,p_draft uuid,p_state jsonb,p_revision integer)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
begin
  insert into public.studio_editor_state(draft_id,workspace_id,state,version,updated_at)
    values(p_draft,p_workspace,p_state,p_revision,now())
    on conflict(draft_id) do update set state=excluded.state,version=excluded.version,updated_at=now()
    where studio_editor_state.workspace_id=p_workspace and studio_editor_state.version<=excluded.version;
  return found;
end $$;
revoke all on function public.studio_save_editor_state(uuid,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.studio_save_editor_state(uuid,uuid,jsonb,integer) to service_role;

create or replace function public.studio_create_operation(p_workspace uuid,p_id uuid,p_draft uuid,p_kind text,p_input jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare existing uuid;
begin
  perform 1 from public.content_studio_workspaces where id=p_workspace for update;
  if not found then raise exception 'Workspace not found'; end if;
  if p_kind in ('sync','publish') then
    select id into existing from public.studio_operations where workspace_id=p_workspace and draft_id=p_draft and kind=p_kind and status in ('queued','running')
      and case when p_kind='publish' then input->>'jobId'=p_input->>'jobId' else input->>'expectedRevision'=p_input->>'expectedRevision' end limit 1;
    if existing is not null then return existing; end if;
  end if;
  insert into public.studio_operations(id,workspace_id,draft_id,kind,input) values(p_id,p_workspace,p_draft,p_kind,p_input);
  perform public.studio_enqueue_work(p_workspace,'studio_operation',p_id);
  return p_id;
end $$;
revoke all on function public.studio_create_operation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_create_operation(uuid,uuid,uuid,text,jsonb) to service_role;

create or replace function public.studio_repair_pending_adaptations()
returns integer language plpgsql security definer set search_path=public,pg_catalog as $$
declare workspace record; draft jsonb; repaired integer:=0;
begin
  for workspace in select id,state from public.content_studio_workspaces loop
    for draft in select value from jsonb_array_elements(workspace.state->'drafts') where value->>'adaptationStatus'='pending' loop
      if not exists(select 1 from public.studio_operations where workspace_id=workspace.id and draft_id=(draft->>'id')::uuid and kind='sync' and input->>'expectedRevision'=draft->>'revision') then
        perform public.studio_create_operation(workspace.id,gen_random_uuid(),(draft->>'id')::uuid,'sync',jsonb_build_object('expectedRevision',(draft->>'revision')::integer));
        repaired:=repaired+1;
      end if;
    end loop;
  end loop;
  return repaired;
end $$;
revoke all on function public.studio_repair_pending_adaptations() from public,anon,authenticated;
grant execute on function public.studio_repair_pending_adaptations() to service_role;
select cron.schedule('content-studio-adaptation-repair','* * * * *','select public.studio_repair_pending_adaptations()');

-- Applying a reviewed proposal and marking its receipt share one transaction.
-- Workspace-first locking matches the existing workspace CAS and operation creator.
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
  if (operation_row.input->>'expectedRevision')::integer<>p_expected_revision or (draft->>'revision')::integer<>p_expected_revision then
    raise exception 'The draft changed after this proposal was generated';
  end if;
  if p_content is distinct from operation_row.output->'proposal' then raise exception 'The reviewed proposal content does not match'; end if;
  if exists(select 1 from jsonb_array_elements(workspace_row.state->'jobs') where value->>'draftId'=p_draft::text and value->>'status'='submitting') then
    raise exception 'Reconcile the active publication before editing';
  end if;
  updated_draft:=(draft-'lastOperationId')||p_content||jsonb_build_object('revision',p_expected_revision+1,'approvedHash',null,'lastAppliedProposalId',p_operation);
  if draft->>'title' is distinct from p_content->>'title' or draft->>'body' is distinct from p_content->>'body' then
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

create or replace function public.studio_cancel_operation(p_workspace uuid,p_operation uuid)
returns uuid language plpgsql security definer set search_path=public,pg_catalog as $$
declare operation_row public.studio_operations%rowtype;
begin
  select * into operation_row from public.studio_operations where id=p_operation and workspace_id=p_workspace for update;
  if not found then raise exception 'Operation not found'; end if;
  if operation_row.kind='publish' and operation_row.status='running' then raise exception 'Publication may already be submitted; reconcile its platform result'; end if;
  if operation_row.status='succeeded' and (operation_row.kind<>'refine' or coalesce((operation_row.output->>'applied')::boolean,false)) then
    raise exception 'Completed work cannot be cancelled';
  end if;
  if operation_row.status in ('queued','running','succeeded') then
    update public.studio_operations set status='cancelled',phase='Cancelled by owner',updated_at=now() where id=p_operation;
  end if;
  return p_operation;
end $$;
revoke all on function public.studio_cancel_operation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.studio_cancel_operation(uuid,uuid) to service_role;
