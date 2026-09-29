-- M2: atomic firm import. Inserts new firms and their firm_imported audit
-- events in one statement, so a firm can never exist without its event.
-- Existing domains are skipped (never overwritten); callers diff the
-- returned rows against what they sent to report skips.

create or replace function public.import_firms(p_firms jsonb, p_source text, p_import_id text)
returns table (id uuid, domain text)
language sql
security invoker
set search_path = ''
as $$
  with incoming as (
    select *
    from jsonb_to_recordset(p_firms)
      as f(name text, domain text, city text, county text, state text, row_number int)
  ),
  inserted as (
    insert into public.firms (name, domain, city, county, state, source)
    select i.name, i.domain, i.city, i.county, i.state, p_source
    from incoming i
    on conflict (domain) do nothing
    returning firms.id, firms.domain
  ),
  logged as (
    insert into public.pipeline_events (entity, entity_id, type, payload, idempotency_key)
    select
      'firm',
      ins.id,
      'firm_imported',
      jsonb_build_object(
        'source', p_source,
        'import_id', p_import_id,
        'domain', ins.domain,
        'row_number', i.row_number
      ),
      'firm_imported:' || ins.id
    from inserted ins
    join incoming i on i.domain = ins.domain
  )
  select ins.id, ins.domain from inserted ins;
$$;

revoke execute on function public.import_firms(jsonb, text, text) from public, anon, authenticated;
grant execute on function public.import_firms(jsonb, text, text) to service_role;
