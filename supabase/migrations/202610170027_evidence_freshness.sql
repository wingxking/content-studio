-- A content version is immutable; a later identical fetch records a separate confirmation.
alter table public.studio_evidence_documents add column last_confirmed_at timestamptz;
create function public.studio_confirm_evidence(p_workspace uuid,p_document text,p_observed timestamptz)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if p_observed>now()+interval '5 minutes' then raise exception 'Invalid evidence confirmation time'; end if;
 update public.studio_evidence_documents set last_confirmed_at=greatest(last_confirmed_at,p_observed)
 where workspace_id=p_workspace and id=p_document;
 if not found then raise exception 'Evidence document is missing'; end if;
end $$;
revoke all on function public.studio_confirm_evidence(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.studio_confirm_evidence(uuid,text,timestamptz) to service_role;
notify pgrst,'reload schema';
