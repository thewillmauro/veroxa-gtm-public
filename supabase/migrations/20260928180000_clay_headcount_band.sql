-- Clay headcount ranges: the contract now accepts "11-50"-style ranges,
-- stores the lower bound in headcount_est, and derives firm_size_band.
-- Adds p_firm_size_band to apply_clay_callback(); the old 8-argument
-- version is dropped (not overloaded) so PostgREST can't pick the wrong one.
-- Redeploy clay-callback right after this migration. See ADR 0008.

drop function public.apply_clay_callback(uuid, text, jsonb, int, boolean, text, jsonb, jsonb);

create or replace function public.apply_clay_callback(
  p_firm_id uuid,
  p_idempotency_key text,
  p_raw jsonb,
  p_headcount int,
  p_firm_size_band text,   -- derived from headcount by the contract (ADR 0008); null keeps the existing band
  p_handles_custody boolean,
  p_custody_evidence_url text,
  p_people jsonb,          -- normalized: [{email, full_name, title, email_source, email_verified, linkedin_url, is_decision_maker}]
  p_dropped_people jsonb   -- [{index, reason}] for the audit trail
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status public.pipeline_status;
  v_person record;
  v_rows int;
  v_upserted int := 0;
  v_other_firm text[] := '{}';
  v_advanced boolean := false;
begin
  -- Lock the firm row so concurrent callbacks for one firm serialize.
  select status into v_status from public.firms where id = p_firm_id for update;
  if not found then
    return jsonb_build_object('result', 'unknown_firm');
  end if;

  -- Idempotency: the raw payload event doubles as the dedupe record.
  insert into public.pipeline_events (entity, entity_id, type, payload, idempotency_key)
  values ('firm', p_firm_id, 'clay_callback_received', p_raw, p_idempotency_key)
  on conflict (idempotency_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- Enrichment: only overwrite with values Clay actually returned.
  update public.firms
  set headcount_est = coalesce(p_headcount, headcount_est),
      firm_size_band = coalesce(p_firm_size_band, firm_size_band),
      handles_custody = coalesce(p_handles_custody, handles_custody),
      custody_evidence_url = coalesce(p_custody_evidence_url, custody_evidence_url)
  where id = p_firm_id;

  -- Contacts: upsert by email within this firm. An email already owned by a
  -- different firm is left alone and reported, never reassigned.
  for v_person in
    select * from jsonb_to_recordset(coalesce(p_people, '[]'::jsonb)) as x(
      email text, full_name text, title text, email_source text,
      email_verified boolean, linkedin_url text, is_decision_maker boolean
    )
  loop
    insert into public.contacts as c (
      firm_id, email, full_name, title, email_source, email_verified, linkedin_url, is_decision_maker
    )
    values (
      p_firm_id, v_person.email, v_person.full_name, v_person.title, v_person.email_source,
      v_person.email_verified, v_person.linkedin_url, v_person.is_decision_maker
    )
    on conflict (email) do update
      set full_name = coalesce(excluded.full_name, c.full_name),
          title = coalesce(excluded.title, c.title),
          email_source = coalesce(excluded.email_source, c.email_source),
          email_verified = coalesce(excluded.email_verified, c.email_verified),
          linkedin_url = coalesce(excluded.linkedin_url, c.linkedin_url),
          is_decision_maker = coalesce(excluded.is_decision_maker, c.is_decision_maker)
      where c.firm_id = excluded.firm_id;
    get diagnostics v_rows = row_count;
    if v_rows = 1 then
      v_upserted := v_upserted + 1;
    else
      v_other_firm := v_other_firm || v_person.email;
    end if;
  end loop;

  -- Advance status, never regress a firm that has moved past enrichment.
  if v_status in ('new', 'sent_to_clay') then
    update public.firms set status = 'enriched' where id = p_firm_id;
    insert into public.pipeline_events (entity, entity_id, type, payload)
    values ('firm', p_firm_id, 'status_changed', jsonb_build_object(
      'from', v_status, 'to', 'enriched', 'reason', 'clay_callback',
      'detail', jsonb_build_object('idempotency_key', p_idempotency_key)
    ));
    v_advanced := true;
  end if;

  insert into public.pipeline_events (entity, entity_id, type, payload)
  values ('firm', p_firm_id, 'clay_callback_applied', jsonb_build_object(
    'idempotency_key', p_idempotency_key,
    'contacts_upserted', v_upserted,
    'contacts_owned_by_other_firm', to_jsonb(v_other_firm),
    'people_dropped', coalesce(p_dropped_people, '[]'::jsonb),
    'status_advanced', v_advanced
  ));

  return jsonb_build_object(
    'result', 'applied',
    'status_from', v_status,
    'status_to', case when v_advanced then 'enriched' else v_status::text end,
    'contacts_upserted', v_upserted,
    'contacts_owned_by_other_firm', to_jsonb(v_other_firm)
  );
end;
$$;

revoke execute on function public.apply_clay_callback(uuid, text, jsonb, int, text, boolean, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_clay_callback(uuid, text, jsonb, int, text, boolean, text, jsonb, jsonb)
  to service_role;
