-- Repeated snapshots and syndicated copies must not consume every retrieval slot.
create or replace function public.studio_evidence_search(p_workspace uuid,p_terms text,p_vector extensions.vector(384) default null,p_limit integer default 20,p_embedding_version text default 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3')
returns table(document_id text,chunk_id text,score double precision) language sql stable security definer set search_path=public,extensions,pg_catalog as $$
 with latest as (
  select distinct on(coalesce(metadata->>'url',id)) * from public.studio_evidence_documents
  where workspace_id=p_workspace
  order by coalesce(metadata->>'url',id),coalesce(last_confirmed_at,(metadata->>'fetchedAt')::timestamptz,created_at) desc,id
 ), unique_content as (
  select distinct on(coalesce(metadata->>'originHash',id),coalesce(metadata->>'evidenceType','reference')) id
  from latest order by coalesce(metadata->>'originHash',id),coalesce(metadata->>'evidenceType','reference'),
  case metadata->>'access' when 'full' then 0 when 'partial' then 1 else 2 end,
  case metadata->>'category' when 'primary' then 0 when 'research' then 1 else 2 end,
  coalesce(last_confirmed_at,(metadata->>'fetchedAt')::timestamptz,created_at) desc,id
 ), eligible as (
  select c.* from public.studio_evidence_chunks c join unique_content d on d.id=c.document_id where c.workspace_id=p_workspace
 ), kw as (
  select c.id,row_number() over(order by ts_rank_cd(c.keywords,websearch_to_tsquery('simple',p_terms)) desc,c.id) r
  from eligible c where c.keywords @@ websearch_to_tsquery('simple',p_terms) order by ts_rank_cd(c.keywords,websearch_to_tsquery('simple',p_terms)) desc,c.id limit 60
 ), sem as (
  select c.id,row_number() over(order by c.embedding <=> p_vector,c.id) r from eligible c
  where p_vector is not null and c.embedding is not null and c.embedding_version=p_embedding_version order by c.embedding <=> p_vector,c.id limit 60
 )
 select c.document_id,c.id,(coalesce(1.0/(60+kw.r),0)+coalesce(1.0/(60+sem.r),0))::double precision
 from eligible c left join kw on kw.id=c.id left join sem on sem.id=c.id where kw.id is not null or sem.id is not null
 order by 3 desc,c.id limit greatest(1,least(p_limit,40));
$$;
notify pgrst,'reload schema';
