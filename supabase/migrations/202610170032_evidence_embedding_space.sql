-- Foreign-language keyword anchors remain readable after model upgrades; never compare their old embedding space to a new query vector.
create or replace function public.studio_evidence_search(p_workspace uuid,p_terms text,p_vector extensions.vector(384) default null,p_limit integer default 20,p_embedding_version text default 'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3')
returns table(document_id text,chunk_id text,score double precision) language sql stable security definer set search_path=public,extensions,pg_catalog as $$
 with query as (
  select websearch_to_tsquery('simple',p_terms) exact_query,
  websearch_to_tsquery('simple',coalesce((select string_agg(token[1],' ') from regexp_matches(p_terms,'[a-zA-Z][a-zA-Z0-9_-]{1,}','g') token),'')) latin_query,
  to_tsquery('simple',coalesce((select string_agg(quote_literal(term),' | ') from unnest(tsvector_to_array(to_tsvector('simple',p_terms))) term),'')) broad_query
 ), latest as (
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
  select c.id,row_number() over(order by (ts_rank_cd(c.keywords,q.exact_query)*2+ts_rank_cd(c.keywords,q.broad_query)) desc,c.id) r
  from eligible c cross join query q where c.keywords @@ q.broad_query
  order by (ts_rank_cd(c.keywords,q.exact_query)*2+ts_rank_cd(c.keywords,q.broad_query)) desc,c.id limit 60
 ), sem as (
  select c.id,row_number() over(order by c.embedding <=> p_vector,c.id) r from eligible c
  where p_vector is not null and c.embedding is not null and c.embedding_version=p_embedding_version order by c.embedding <=> p_vector,c.id limit 60
 ), foreign_documents as (
  select distinct on(c.document_id) c.id,c.document_id,case when p_vector is null or c.embedding is null or c.embedding_version is distinct from p_embedding_version then 1.0 else c.embedding <=> p_vector end distance
  from eligible c cross join query q where p_terms ~ '[一-龥]' and numnode(q.latin_query)>0 and c.keywords::text !~ '[一-龥]' and c.keywords @@ q.latin_query
  order by c.document_id,distance,c.id
 ), foreign_anchors as (
  select id from foreign_documents order by distance,id limit 2
 ), fused as (
  select c.document_id,c.id,(coalesce(1.0/(60+kw.r),0)+coalesce(1.0/(60+sem.r),0))::double precision score
  from eligible c left join kw on kw.id=c.id left join sem on sem.id=c.id where kw.id is not null or sem.id is not null or c.id in(select id from foreign_anchors)
 ), diverse as (
  select *,row_number() over(partition by document_id order by score desc,id) document_rank from fused
 )
 select document_id,id,score from diverse where document_rank<=3
 order by case when id in(select id from foreign_anchors) then 0 else 1 end,score desc,id limit greatest(1,least(p_limit,40));
$$;
notify pgrst,'reload schema';
