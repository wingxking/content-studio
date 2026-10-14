-- A database-wide account lock and dispatch barrier; credentials are never stored here.
create table public.studio_account_execution_leases (
 physical_key text primary key check (physical_key ~ '^[a-f0-9]{64}$'),
 workspace_id uuid references public.content_studio_workspaces(id), owner_token uuid,
 job_id uuid, purpose text check(purpose in ('write','reconcile','resume','metrics','handoff')),
 expires_at timestamptz not null default now(), pending_workspace uuid,
 pending_job uuid, dispatched_at timestamptz, updated_at timestamptz not null default now()
);
alter table public.studio_account_execution_leases enable row level security;
revoke all on public.studio_account_execution_leases from public,anon,authenticated;
grant all on public.studio_account_execution_leases to service_role;
create function public.studio_acquire_account_execution(p_workspace uuid,p_key text,p_token uuid,p_job uuid,p_purpose text)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
declare item public.studio_account_execution_leases%rowtype;
begin
 if p_purpose not in ('write','reconcile','resume','metrics','handoff') or p_token is null then raise exception 'Invalid account execution request'; end if;
 perform 1 from public.content_studio_workspaces where id=p_workspace;
 if not found then raise exception 'Workspace not found'; end if;
 insert into public.studio_account_execution_leases(physical_key) values(p_key) on conflict do nothing;
 select * into item from public.studio_account_execution_leases where physical_key=p_key for update;
 if item.owner_token is not null and item.expires_at>now() then return false; end if;
 if item.pending_job is not null and not (p_purpose in ('reconcile','resume') and item.pending_job=p_job and item.pending_workspace=p_workspace) then return false; end if;
 update public.studio_account_execution_leases set workspace_id=p_workspace,owner_token=p_token,job_id=p_job,purpose=p_purpose,expires_at=now()+interval '60 seconds',updated_at=now() where physical_key=p_key;
 return true;
end $$;
create function public.studio_renew_account_execution(p_workspace uuid,p_key text,p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 update public.studio_account_execution_leases set expires_at=now()+interval '60 seconds',updated_at=now() where physical_key=p_key and workspace_id=p_workspace and owner_token=p_token and expires_at>now();
 return found;
end $$;
create function public.studio_mark_account_dispatch(p_workspace uuid,p_key text,p_token uuid,p_job uuid)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 update public.studio_account_execution_leases set pending_workspace=p_workspace,pending_job=p_job,dispatched_at=coalesce(dispatched_at,now()),updated_at=now()
 where physical_key=p_key and workspace_id=p_workspace and owner_token=p_token and job_id=p_job and purpose in ('write','resume') and expires_at>now() and (pending_job is null or pending_job=p_job and pending_workspace=p_workspace);
 return found;
end $$;
create function public.studio_release_account_execution(p_workspace uuid,p_key text,p_token uuid,p_resolved boolean)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 update public.studio_account_execution_leases set owner_token=null,expires_at=now(),updated_at=now(),
 pending_workspace=case when p_resolved and pending_job=job_id and pending_workspace=p_workspace then null else pending_workspace end,
 pending_job=case when p_resolved and pending_job=job_id and pending_workspace=p_workspace then null else pending_job end,
 dispatched_at=case when p_resolved and pending_job=job_id and pending_workspace=p_workspace then null else dispatched_at end
 where physical_key=p_key and workspace_id=p_workspace and owner_token=p_token and expires_at>now();
 return found;
end $$;
create function public.studio_commit_account_workspace(p_workspace uuid,p_key text,p_token uuid,p_revision integer,p_state jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare result jsonb;
begin
 perform 1 from public.studio_account_execution_leases where physical_key=p_key and workspace_id=p_workspace and owner_token=p_token and expires_at>now() for update;
 if not found then raise exception 'Account execution ownership lost'; end if;
 update public.content_studio_workspaces set state=p_state,revision=revision+1,updated_at=now() where id=p_workspace and revision=p_revision returning jsonb_build_array(jsonb_build_object('id',id,'revision',revision,'state',state)) into result;
 return coalesce(result,'[]'::jsonb);
end $$;
revoke all on function public.studio_acquire_account_execution(uuid,text,uuid,uuid,text),public.studio_renew_account_execution(uuid,text,uuid),public.studio_mark_account_dispatch(uuid,text,uuid,uuid),public.studio_release_account_execution(uuid,text,uuid,boolean),public.studio_commit_account_workspace(uuid,text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.studio_acquire_account_execution(uuid,text,uuid,uuid,text),public.studio_renew_account_execution(uuid,text,uuid),public.studio_mark_account_dispatch(uuid,text,uuid,uuid),public.studio_release_account_execution(uuid,text,uuid,boolean),public.studio_commit_account_workspace(uuid,text,uuid,integer,jsonb) to service_role;
notify pgrst,'reload schema';
