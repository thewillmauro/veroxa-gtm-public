// Applies every file in supabase/migrations to an in-process Postgres
// (PGlite) and checks the schema's guarantees. This is the local gate
// before `supabase db push`; no Docker needed.
//
// Supabase roles and default grants are recreated first, so the test
// proves the migration's revokes win over Supabase's permissive defaults.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'supabase', 'migrations')

const SUPABASE_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

const TABLES = ['firms', 'contacts', 'research', 'outreach_drafts', 'inbound_signups', 'suppressions', 'pipeline_events', 'job_locks']

let db: PGlite

async function sqlError(sql: string): Promise<string | null> {
  try {
    await db.exec(sql)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_BOOTSTRAP)
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
}, 60_000)

describe('migrations', () => {
  it('create every §6 table with RLS enabled and no policies', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    )
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort())
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
    const { rows: policies } = await db.query(`select 1 from pg_policies where schemaname = 'public'`)
    expect(policies).toHaveLength(0)
  })

  it('give anon and authenticated no table privileges; service_role keeps them', async () => {
    for (const t of TABLES) {
      const { rows } = await db.query<{ anon: boolean; authed: boolean; svc: boolean }>(
        `select has_table_privilege('anon', 'public.${t}', 'select,insert,update,delete') as anon,
                has_table_privilege('authenticated', 'public.${t}', 'select,insert,update,delete') as authed,
                has_table_privilege('service_role', 'public.${t}', 'select') and has_table_privilege('service_role', 'public.${t}', 'insert') as svc`,
      )
      expect(rows[0], t).toEqual({ anon: false, authed: false, svc: true })
    }
  })

  it('deny anon at query time', async () => {
    const err = await sqlError(`set role anon; select * from public.firms; reset role;`)
    await db.exec('reset role')
    expect(err).toMatch(/permission denied/)
  })

  it('default a new firm to status new and bump updated_at on update', async () => {
    const { rows } = await db.query<{ id: string; status: string; updated_at: Date }>(
      `insert into firms (name, domain, source) values ('A', 'a.example.com', 'test') returning id, status, updated_at`,
    )
    const firm = rows[0]!
    expect(firm.status).toBe('new')
    await new Promise((r) => setTimeout(r, 5))
    const { rows: after } = await db.query<{ updated_at: Date }>(`update firms set status = 'enriched' where id = $1 returning updated_at`, [firm.id])
    expect(after[0]!.updated_at.getTime()).toBeGreaterThan(firm.updated_at.getTime())
  })

  it('enforce lowercase emails/domains and value checks', async () => {
    expect(await sqlError(`insert into firms (name, domain, source) values ('B', 'Mixed.com', 'test')`)).toMatch(/check constraint/)
    expect(await sqlError(`insert into firms (name, source, state) values ('B', 'test', 'new jersey')`)).toMatch(/check constraint/)
    expect(await sqlError(`insert into firms (name, source, firm_size_band) values ('B', 'test', 'huge')`)).toMatch(/check constraint/)
    expect(await sqlError(`insert into suppressions (email, reason, source) values ('A@B.com', 'manual', 'test')`)).toMatch(/check constraint/)
    expect(await sqlError(`insert into firms (name) values ('no source')`)).toMatch(/null value/)
  })

  it('cascade contacts on firm delete and null out inbound matches', async () => {
    const { rows: f } = await db.query<{ id: string }>(`insert into firms (name, domain, source) values ('C', 'c.example.com', 'test') returning id`)
    const firmId = f[0]!.id
    const { rows: c } = await db.query<{ id: string }>(`insert into contacts (firm_id, email) values ($1, 'x@c.example.com') returning id`, [firmId])
    await db.query(
      `insert into inbound_signups (source_system, source_id, email, persona, matched_contact_id, matched_firm_id) values ('veroxa.waitlist', '1', 'x@c.example.com', 'attorney', $1, $2)`,
      [c[0]!.id, firmId],
    )
    await db.query(`delete from firms where id = $1`, [firmId])
    const { rows: left } = await db.query(`select 1 from contacts where firm_id = $1`, [firmId])
    expect(left).toHaveLength(0)
    const { rows: inbound } = await db.query<{ matched_contact_id: string | null; matched_firm_id: string | null }>(
      `select matched_contact_id, matched_firm_id from inbound_signups where source_id = '1'`,
    )
    expect(inbound[0]).toEqual({ matched_contact_id: null, matched_firm_id: null })
  })

  it('make inbound_signups idempotent per source row', async () => {
    const insert = `insert into inbound_signups (source_system, source_id, email) values ('veroxa.waitlist', 'dup', 'a@b.com')`
    await db.exec(insert)
    expect(await sqlError(insert)).toMatch(/duplicate key/)
  })

  it('make pipeline_events append-only (update, delete, truncate)', async () => {
    const { rows } = await db.query<{ id: number }>(`insert into pipeline_events (entity, type) values ('system', 'test') returning id`)
    const id = rows[0]!.id
    expect(await sqlError(`update pipeline_events set type = 'x' where id = ${id}`)).toMatch(/append-only/)
    expect(await sqlError(`delete from pipeline_events where id = ${id}`)).toMatch(/append-only/)
    expect(await sqlError(`truncate pipeline_events`)).toMatch(/append-only/)
  })

  it('reject a repeated idempotency key', async () => {
    const insert = `insert into pipeline_events (entity, type, idempotency_key) values ('firm', 'clay_callback_received', 'k1')`
    await db.exec(insert)
    expect(await sqlError(insert)).toMatch(/duplicate key/)
  })

  describe('import_firms()', () => {
    const firms = (...domains: string[]) =>
      JSON.stringify(domains.map((d, i) => ({ name: `Firm ${d}`, domain: d, city: 'Red Bank', county: 'Monmouth', state: 'NJ', row_number: i + 2 })))

    it('inserts firms with the source and one firm_imported event each', async () => {
      const { rows } = await db.query<{ id: string; domain: string }>(`select * from import_firms($1::jsonb, 'manual_csv', 'imp-1')`, [firms('i1.com', 'i2.com')])
      expect(rows.map((r) => r.domain).sort()).toEqual(['i1.com', 'i2.com'])
      const { rows: f } = await db.query<{ source: string; status: string; county: string }>(`select source, status, county from firms where domain = 'i1.com'`)
      expect(f[0]).toEqual({ source: 'manual_csv', status: 'new', county: 'Monmouth' })
      const { rows: ev } = await db.query<{ entity_id: string; payload: any; idempotency_key: string }>(
        `select entity_id, payload, idempotency_key from pipeline_events where type = 'firm_imported' and payload->>'import_id' = 'imp-1' order by payload->>'row_number'`,
      )
      expect(ev).toHaveLength(2)
      expect(ev[0]!.payload).toEqual({ source: 'manual_csv', import_id: 'imp-1', domain: 'i1.com', row_number: 2 })
      expect(ev[0]!.idempotency_key).toBe(`firm_imported:${ev[0]!.entity_id}`)
    })

    it('skips existing domains without overwriting them or logging events', async () => {
      await db.query(`update firms set name = 'Edited by hand' where domain = 'i1.com'`)
      const { rows } = await db.query<{ domain: string }>(`select * from import_firms($1::jsonb, 'manual_csv:other', 'imp-2')`, [firms('i1.com', 'i3.com')])
      expect(rows.map((r) => r.domain)).toEqual(['i3.com'])
      const { rows: f } = await db.query<{ name: string; source: string }>(`select name, source from firms where domain = 'i1.com'`)
      expect(f[0]).toEqual({ name: 'Edited by hand', source: 'manual_csv' })
      const { rows: ev } = await db.query(`select 1 from pipeline_events where payload->>'import_id' = 'imp-2'`)
      expect(ev).toHaveLength(1)
    })

    it('rolls back firms if the batch fails a constraint', async () => {
      const bad = JSON.stringify([
        { name: 'Good', domain: 'rb-good.com', state: 'NJ', row_number: 2 },
        { name: 'Bad', domain: 'RB-BAD.com', state: 'NJ', row_number: 3 },
      ])
      expect(await sqlError(`select * from import_firms('${bad}'::jsonb, 'manual_csv', 'imp-3')`)).toMatch(/check constraint/)
      const { rows } = await db.query(`select 1 from firms where domain = 'rb-good.com'`)
      expect(rows).toHaveLength(0)
    })

    it('is executable by service_role only', async () => {
      const { rows } = await db.query<{ anon: boolean; authed: boolean; svc: boolean }>(
        `select has_function_privilege('anon', 'public.import_firms(jsonb,text,text)', 'execute') as anon,
                has_function_privilege('authenticated', 'public.import_firms(jsonb,text,text)', 'execute') as authed,
                has_function_privilege('service_role', 'public.import_firms(jsonb,text,text)', 'execute') as svc`,
      )
      expect(rows[0]).toEqual({ anon: false, authed: false, svc: true })
    })
  })

  describe('apply_clay_callback()', () => {
    let firmId: string
    let otherFirmId: string
    const person = (email: string, extra: Record<string, unknown> = {}) => ({
      email, full_name: 'Jane Rivera', title: 'Managing Partner', email_source: 'provider_b',
      email_verified: true, linkedin_url: null, is_decision_maker: true, ...extra,
    })
    const apply = async (key: string, people: unknown[], opts: { firm?: string; headcount?: number | null; band?: string | null; custody?: boolean | null; url?: string | null } = {}) => {
      const { rows } = await db.query<{ r: any }>(
        `select apply_clay_callback($1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9::jsonb) as r`,
        [opts.firm ?? firmId, key, JSON.stringify({ raw: key }), opts.headcount ?? null, opts.band ?? null, opts.custody ?? null, opts.url ?? null, JSON.stringify(people), '[]'],
      )
      return rows[0]!.r
    }

    beforeAll(async () => {
      const { rows } = await db.query<{ id: string }>(`insert into firms (name, domain, source, status) values ('Clay A', 'clay-a.com', 'test', 'sent_to_clay') returning id`)
      firmId = rows[0]!.id
      const { rows: o } = await db.query<{ id: string }>(`insert into firms (name, domain, source) values ('Clay B', 'clay-b.com', 'test') returning id`)
      otherFirmId = o[0]!.id
      await db.query(`insert into contacts (firm_id, email) values ($1, 'shared@clay-b.com')`, [otherFirmId])
    })

    it('enriches the firm, upserts contacts, advances status and logs events', async () => {
      const r = await apply('clay-test-k1', [person('jane@clay-a.com')], { headcount: 6, band: 'small', custody: true, url: 'https://clay-a.com/custody' })
      expect(r).toEqual({ result: 'applied', status_from: 'sent_to_clay', status_to: 'enriched', contacts_upserted: 1, contacts_owned_by_other_firm: [], demoted_contacts: [] })
      const { rows: f } = await db.query(`select status, headcount_est, firm_size_band, handles_custody, custody_evidence_url from firms where id = $1`, [firmId])
      expect(f[0]).toEqual({ status: 'enriched', headcount_est: 6, firm_size_band: 'small', handles_custody: true, custody_evidence_url: 'https://clay-a.com/custody' })
      const { rows: c } = await db.query(`select email, title, is_decision_maker, email_verified from contacts where firm_id = $1`, [firmId])
      expect(c).toEqual([{ email: 'jane@clay-a.com', title: 'Managing Partner', is_decision_maker: true, email_verified: true }])
      const { rows: ev } = await db.query<{ type: string }>(`select type from pipeline_events where entity_id = $1 order by id`, [firmId])
      expect(ev.map((e) => e.type)).toEqual(['clay_callback_received', 'status_changed', 'clay_callback_applied'])
    })

    it('treats a repeated idempotency key as a duplicate and changes nothing', async () => {
      const before = await db.query(`select count(*)::int n from pipeline_events where entity_id = $1`, [firmId])
      expect(await apply('clay-test-k1', [person('someone-new@clay-a.com')])).toEqual({ result: 'duplicate' })
      const after = await db.query(`select count(*)::int n from pipeline_events where entity_id = $1`, [firmId])
      expect(after.rows).toEqual(before.rows)
      const { rows } = await db.query(`select 1 from contacts where email = 'someone-new@clay-a.com'`)
      expect(rows).toHaveLength(0)
    })

    it('updates an existing contact without blanking fields, and never regresses status', async () => {
      await db.query(`update firms set status = 'qualified' where id = $1`, [firmId])
      const r = await apply('clay-test-k2', [person('jane@clay-a.com', { title: null, email_verified: false })], { headcount: null, custody: null })
      expect(r).toMatchObject({ result: 'applied', status_from: 'qualified', status_to: 'qualified', contacts_upserted: 1 })
      const { rows: c } = await db.query(`select title, email_verified from contacts where email = 'jane@clay-a.com'`)
      expect(c[0]).toEqual({ title: 'Managing Partner', email_verified: false })
      const { rows: f } = await db.query(`select status, headcount_est, firm_size_band, handles_custody from firms where id = $1`, [firmId])
      expect(f[0]).toEqual({ status: 'qualified', headcount_est: 6, firm_size_band: 'small', handles_custody: true })
    })

    it('overwrites the band when a new headcount arrives, and rejects an invalid band', async () => {
      await apply('clay-test-band', [], { headcount: 51, band: 'large' })
      const { rows } = await db.query(`select headcount_est, firm_size_band from firms where id = $1`, [firmId])
      expect(rows[0]).toEqual({ headcount_est: 51, firm_size_band: 'large' })
      expect(await sqlError(`select apply_clay_callback('${firmId}', 'clay-test-bad-band', '{}'::jsonb, 5, 'tiny', null, null, '[]'::jsonb, '[]'::jsonb)`)).toMatch(/check constraint/)
    })

    it('leaves an email owned by another firm alone and reports it', async () => {
      const r = await apply('clay-test-k3', [person('shared@clay-b.com')])
      expect(r).toMatchObject({ contacts_upserted: 0, contacts_owned_by_other_firm: ['shared@clay-b.com'] })
      const { rows } = await db.query<{ firm_id: string }>(`select firm_id from contacts where email = 'shared@clay-b.com'`)
      expect(rows[0]!.firm_id).toBe(otherFirmId)
    })

    it('returns unknown_firm without writing anything', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000'
      expect(await apply('clay-test-k4', [person('ghost@x.com')], { firm: ghost })).toEqual({ result: 'unknown_firm' })
      const { rows } = await db.query(`select 1 from pipeline_events where idempotency_key = 'clay-test-k4'`)
      expect(rows).toHaveLength(0)
    })

    it('replaced the old 8-argument signature instead of overloading it', async () => {
      const { rows } = await db.query(`select count(*)::int n from pg_proc where proname = 'apply_clay_callback'`)
      expect(rows[0]).toEqual({ n: 1 })
    })

    it('is executable by service_role only', async () => {
      const sig = 'public.apply_clay_callback(uuid,text,jsonb,int,text,boolean,text,jsonb,jsonb)'
      const { rows } = await db.query(
        `select has_function_privilege('anon', '${sig}', 'execute') as anon,
                has_function_privilege('authenticated', '${sig}', 'execute') as authed,
                has_function_privilege('service_role', '${sig}', 'execute') as svc`,
      )
      expect(rows[0]).toEqual({ anon: false, authed: false, svc: true })
    })
  })

  describe('apply_clay_callback() with a research_agent decision-maker', () => {
    let firmId: string
    let otherFirmId: string
    const call = async (key: string, firm: string, people: unknown[]) => {
      const { rows } = await db.query<{ r: any }>(
        `select apply_clay_callback($1, $2, '{}'::jsonb, null, null, null, null, $3::jsonb, '[]'::jsonb) as r`,
        [firm, key, JSON.stringify(people)],
      )
      return rows[0]!.r
    }
    const person = (email: string, extra: Record<string, unknown> = {}) => ({
      email, full_name: 'X', title: 'Partner', email_source: 'clay_waterfall', email_verified: true,
      linkedin_url: null, is_decision_maker: true, decision_maker_source: null, ...extra,
    })

    beforeAll(async () => {
      const { rows } = await db.query<{ id: string }>(
        `insert into firms (name, domain, source, status, headcount_est, handles_custody) values ('DM A', 'dm-a.com', 'test', 'researched', 7, true) returning id`,
      )
      firmId = rows[0]!.id
      const { rows: o } = await db.query<{ id: string }>(`insert into firms (name, domain, source) values ('DM B', 'dm-b.com', 'test') returning id`)
      otherFirmId = o[0]!.id
      // Clay's Find contacts pick (wrong) plus a contact with no email
      await db.query(`insert into contacts (firm_id, email, is_decision_maker) values ($1, 'wrong@dm-a.com', true), ($1, null, true)`, [firmId])
      await db.query(`insert into contacts (firm_id, email, is_decision_maker) values ($1, 'keep@dm-b.com', true)`, [otherFirmId])
    })

    it('a person without the source demotes no one', async () => {
      const r = await call('dm-k0', firmId, [person('someone@dm-a.com')])
      expect(r.demoted_contacts).toEqual([])
      const { rows } = await db.query(`select count(*)::int n from contacts where firm_id = $1 and is_decision_maker`, [firmId])
      expect(rows[0]).toEqual({ n: 3 })
    })

    it('a research contact without an email demotes no one (it is dropped before the database)', async () => {
      const r = await call('dm-k1', firmId, [])
      expect(r.demoted_contacts).toEqual([])
    })

    it('stores the research contact and demotes every other contact of that firm only', async () => {
      const r = await call('dm-k2', firmId, [person('dm@dm-a.com', { title: 'Attorney', decision_maker_source: 'research_agent' })])
      expect(r).toMatchObject({ result: 'applied', contacts_upserted: 1 })
      expect([...r.demoted_contacts].length).toBe(3) // wrong@, someone@, and the no-email contact
      expect(r.demoted_contacts).toEqual(expect.arrayContaining(['wrong@dm-a.com', 'someone@dm-a.com']))

      const { rows } = await db.query<{ email: string | null; is_decision_maker: boolean; decision_maker_source: string | null }>(
        `select email, is_decision_maker, decision_maker_source from contacts where firm_id = $1 order by email nulls last`,
        [firmId],
      )
      expect(rows).toEqual([
        { email: 'dm@dm-a.com', is_decision_maker: true, decision_maker_source: 'research_agent' },
        { email: 'someone@dm-a.com', is_decision_maker: false, decision_maker_source: null },
        { email: 'wrong@dm-a.com', is_decision_maker: false, decision_maker_source: null },
        { email: null, is_decision_maker: false, decision_maker_source: null },
      ])
      const { rows: other } = await db.query(`select is_decision_maker from contacts where firm_id = $1`, [otherFirmId])
      expect(other).toEqual([{ is_decision_maker: true }])
    })

    it('keeps headcount, custody and status when the payload has no company or custody', async () => {
      const { rows } = await db.query(`select status, headcount_est, handles_custody from firms where id = $1`, [firmId])
      expect(rows[0]).toEqual({ status: 'researched', headcount_est: 7, handles_custody: true })
    })

    it('records the research decision-maker and demotions in the audit event', async () => {
      const { rows } = await db.query<{ payload: any }>(
        `select payload from pipeline_events where entity_id = $1 and type = 'clay_callback_applied' and payload->>'idempotency_key' = 'dm-k2'`,
        [firmId],
      )
      expect(rows[0]!.payload.research_decision_makers).toEqual(['dm@dm-a.com'])
      expect(rows[0]!.payload.demoted_contacts).toHaveLength(3)
    })

    it('rejects an unknown source value at the database too', async () => {
      expect(await sqlError(`insert into contacts (firm_id, email, decision_maker_source) values ('${otherFirmId}', 'x@dm-b.com', 'guess')`)).toMatch(/check constraint/)
    })
  })

  describe('research email domain guard', () => {
    let firmId: string
    const call = async (key: string, people: unknown[]) => {
      const { rows } = await db.query<{ r: any }>(
        `select apply_clay_callback($1, $2, '{}'::jsonb, null, null, null, null, $3::jsonb, '[]'::jsonb) as r`,
        [firmId, key, JSON.stringify(people)],
      )
      return rows[0]!.r
    }
    const research = (email: string) => ({
      email, full_name: 'Jennifer D. Whitfield', title: 'Founding Member', email_source: 'clay_waterfall',
      email_verified: true, linkedin_url: null, is_decision_maker: true, decision_maker_source: 'research_agent',
    })

    beforeAll(async () => {
      const { rows } = await db.query<{ id: string }>(`insert into firms (name, domain, source, status) values ('Guard', 'jdwhitfieldlaw-example-test.com', 'test', 'researched') returning id`)
      firmId = rows[0]!.id
      await db.query(`insert into contacts (firm_id, email, is_decision_maker) values ($1, 'old@jdwhitfieldlaw-example-test.com', true)`, [firmId])
    })

    it('refuses a research contact on another domain and writes nothing', async () => {
      const r = await call('guard-k1', [research('jennifer@whitfieldmd-example.com')])
      expect(r).toEqual({ result: 'research_email_domain_mismatch', firm_domain: 'jdwhitfieldlaw-example-test.com', emails: ['jennifer@whitfieldmd-example.com'] })
      const { rows: c } = await db.query(`select email, is_decision_maker from contacts where firm_id = $1`, [firmId])
      expect(c).toEqual([{ email: 'old@jdwhitfieldlaw-example-test.com', is_decision_maker: true }])
      const { rows: ev } = await db.query(`select 1 from pipeline_events where idempotency_key = 'guard-k1'`)
      expect(ev).toHaveLength(0) // a corrected retry isn't blocked as a duplicate
    })

    it('rejects look-alike domains', async () => {
      expect((await call('guard-k2', [research('j@evil-jdwhitfieldlaw-example-test.com')])).result).toBe('research_email_domain_mismatch')
      expect((await call('guard-k3', [research('j@jdwhitfieldlaw-example-test.com.evil.net')])).result).toBe('research_email_domain_mismatch')
    })

    it('accepts the firm domain and its subdomains (emails arrive lowercased by the contract)', async () => {
      expect((await call('guard-k4', [research('jda@jdwhitfieldlaw-example-test.com')])).result).toBe('applied')
      expect((await call('guard-k5', [research('j@mail.jdwhitfieldlaw-example-test.com')])).result).toBe('applied')
    })

    it('does not apply to contacts without the research source (GTM Firms flow)', async () => {
      const r = await call('guard-k6', [{ ...research('someone@other-domain.com'), decision_maker_source: null, is_decision_maker: false }])
      expect(r.result).toBe('applied')
    })
  })

  describe('job locks', () => {
    const A = '00000000-0000-4000-8000-00000000000a'
    const B = '00000000-0000-4000-8000-00000000000b'
    const acquire = async (holder: string, ttl = 60) =>
      (await db.query<{ ok: boolean }>(`select acquire_job_lock('t-lock', '${holder}', ${ttl}) as ok`)).rows[0]!.ok
    const release = async (holder: string) =>
      (await db.query<{ ok: boolean }>(`select release_job_lock('t-lock', '${holder}') as ok`)).rows[0]!.ok

    it('lets one holder in at a time, allows renewal, and frees on release', async () => {
      expect(await acquire(A)).toBe(true)
      expect(await acquire(B)).toBe(false)
      expect(await acquire(A)).toBe(true) // renewal by the same holder
      expect(await release(B)).toBe(false) // can't release someone else's lease
      expect(await release(A)).toBe(true)
      expect(await acquire(B)).toBe(true)
      await release(B)
    })

    it('lets a new holder take an expired lease', async () => {
      expect(await acquire(A)).toBe(true)
      await db.exec(`update job_locks set expires_at = now() - interval '1 second' where name = 't-lock'`)
      expect(await acquire(B)).toBe(true)
      await release(B)
    })

    it('rejects an out-of-range ttl', async () => {
      expect(await sqlError(`select acquire_job_lock('t-lock', '${A}', 0)`)).toMatch(/ttl must be/)
      expect(await sqlError(`select acquire_job_lock('t-lock', '${A}', 3601)`)).toMatch(/ttl must be/)
    })

    it('is executable by service_role only', async () => {
      for (const fn of ['public.acquire_job_lock(text,uuid,int)', 'public.release_job_lock(text,uuid)']) {
        const { rows } = await db.query<{ anon: boolean; authed: boolean; svc: boolean }>(
          `select has_function_privilege('anon', '${fn}', 'execute') as anon,
                  has_function_privilege('authenticated', '${fn}', 'execute') as authed,
                  has_function_privilege('service_role', '${fn}', 'execute') as svc`,
        )
        expect(rows[0], fn).toEqual({ anon: false, authed: false, svc: true })
      }
    })
  })

  it('keep HubSpot company, deal and contact IDs unique when set, and allow many unsynced rows', async () => {
    await db.exec(`insert into firms (name, domain, source) values ('Hs A', 'hs-a.com', 'manual_csv'), ('Hs B', 'hs-b.com', 'manual_csv'), ('Hs C', 'hs-c.com', 'manual_csv')`)
    await db.exec(`update firms set hubspot_company_id = '111', hubspot_deal_id = '900' where domain = 'hs-a.com'`)
    expect(await sqlError(`update firms set hubspot_company_id = '111' where domain = 'hs-b.com'`)).toMatch(/unique/)
    expect(await sqlError(`update firms set hubspot_deal_id = '900' where domain = 'hs-b.com'`)).toMatch(/unique/)
    const { rows } = await db.query(`select 1 from firms where domain in ('hs-b.com', 'hs-c.com') and hubspot_company_id is null`)
    expect(rows).toHaveLength(2)
    await db.exec(`insert into contacts (firm_id, email, hubspot_contact_id) select id, 'a@hs-a.com', '5' from firms where domain = 'hs-a.com'`)
    expect(await sqlError(`insert into contacts (firm_id, email, hubspot_contact_id) select id, 'b@hs-b.com', '5' from firms where domain = 'hs-b.com'`)).toMatch(/unique/)
    await db.exec(`delete from firms where domain in ('hs-a.com', 'hs-b.com', 'hs-c.com')`)
  })

  it('index every foreign key column', async () => {
    const { rows } = await db.query(`
      select conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = a.attnum)`)
    expect(rows).toEqual([])
  })
})
