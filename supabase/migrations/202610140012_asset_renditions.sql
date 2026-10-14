create table public.studio_asset_renditions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.content_studio_workspaces(id),
 source_asset_id uuid not null references public.studio_assets(id),source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),recipe_hash text not null check(recipe_hash ~ '^[a-f0-9]{64}$'),recipe jsonb not null,
 status text not null default 'pending' check(status in ('pending','finalized')),owner_token uuid,lease_until timestamptz,
 result_asset_id uuid references public.studio_assets(id),result_hash text,width integer,height integer,created_at timestamptz not null default now(),
 unique(workspace_id,source_hash,recipe_hash),check(status<>'finalized' or result_asset_id is not null and result_hash is not null and width>0 and height>0)
);
alter table public.studio_asset_renditions enable row level security;
revoke all on public.studio_asset_renditions from public,anon,authenticated;
grant all on public.studio_asset_renditions to service_role;
create function public.studio_claim_asset_rendition(p_workspace uuid,p_source uuid,p_source_hash text,p_recipe_hash text,p_recipe jsonb,p_owner uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare item public.studio_asset_renditions%rowtype;
begin
 perform 1 from public.studio_assets where id=p_source and workspace_id=p_workspace and sha256=p_source_hash and status='finalized';
 if not found then raise exception 'Original asset integrity mismatch'; end if;
 insert into public.studio_asset_renditions(workspace_id,source_asset_id,source_hash,recipe_hash,recipe,owner_token,lease_until) values(p_workspace,p_source,p_source_hash,p_recipe_hash,p_recipe,p_owner,now()+interval '120 seconds') on conflict do nothing;
 select * into item from public.studio_asset_renditions where workspace_id=p_workspace and source_hash=p_source_hash and recipe_hash=p_recipe_hash for update;
 if item.status='pending' and item.lease_until<now() then
 update public.studio_asset_renditions set owner_token=p_owner,lease_until=now()+interval '120 seconds' where id=item.id returning * into item;
 end if;
 return to_jsonb(item);
end $$;
create function public.studio_finalize_asset_rendition(p_workspace uuid,p_id uuid,p_owner uuid,p_asset uuid,p_hash text,p_width integer,p_height integer)
returns boolean language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 perform 1 from public.studio_assets where id=p_asset and workspace_id=p_workspace and sha256=p_hash and status='finalized' and mime='image/jpeg';
 if not found then raise exception 'Finalized rendition bytes are unavailable'; end if;
 update public.studio_asset_renditions set status='finalized',result_asset_id=p_asset,result_hash=p_hash,width=p_width,height=p_height,owner_token=null,lease_until=null where workspace_id=p_workspace and id=p_id and owner_token=p_owner and status='pending' and lease_until>now();
 return found;
end $$;
revoke all on function public.studio_claim_asset_rendition(uuid,uuid,text,text,jsonb,uuid),public.studio_finalize_asset_rendition(uuid,uuid,uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.studio_claim_asset_rendition(uuid,uuid,text,text,jsonb,uuid),public.studio_finalize_asset_rendition(uuid,uuid,uuid,uuid,text,integer,integer) to service_role;
notify pgrst,'reload schema';
