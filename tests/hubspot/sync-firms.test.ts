import { describe, expect, it, vi } from 'vitest'
import { createHubSpotClient } from '../../src/hubspot/client.js'
import type { RecordWithHistory } from '../../src/hubspot/crm.js'
import {
  companyCreateOnlyProps,
  companyVeroxaProps,
  contactCreateProps,
  contactEligibility,
  decideCompanyWrites,
  executeSync,
  formatBreakdown,
  learnOurSourceIds,
  planSync,
  splitName,
  statusAfterSync,
  type ContactRow,
  type FirmRow,
  type SyncInput,
} from '../../src/hubspot/sync-firms.js'
import { createLogger } from '../../src/lib/logger.js'
import { fakeDb } from './fake-db.js'

const quiet = createLogger({ write: () => {} })
const OURS = '10000001'
const T0 = '2026-09-30T04:00:00.000Z'
const T1 = '2026-09-30T05:00:00.000Z'

const BREAKDOWN = {
  version: 'v1',
  disqualified_by: null,
  lines: [
    { rule: 'handles_custody', basis: 'handles custody: yes', points: 40, max: 40 },
    { rule: 'firm_size', basis: 'size band: small', points: 20, max: 20 },
  ],
}

function firm(over: Partial<FirmRow> = {}): FirmRow {
  return {
    id: 'f1',
    name: 'Harbor Family Law',
    domain: 'harborfamily.com',
    city: 'Toms River',
    state: 'NJ',
    source: 'manual_csv',
    status: 'qualified',
    headcount_est: 7,
    fit_score: 60,
    score_breakdown: BREAKDOWN,
    custody_evidence_url: 'https://harborfamily.com/custody',
    hubspot_company_id: null,
    last_synced_at: null,
    ...over,
  }
}

function contact(over: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 'c1',
    firm_id: 'f1',
    full_name: 'Dana R. Whitlock, Esq.',
    title: 'Partner',
    email: 'dwhitlock@harborfamily.com',
    email_verified: true,
    is_decision_maker: true,
    unsubscribed: false,
    hubspot_contact_id: null,
    ...over,
  }
}

describe('pure rules', () => {
  it('moves only qualified firms to synced', () => {
    expect(statusAfterSync('qualified')).toBe('synced')
    for (const s of ['scored', 'synced', 'drafted', 'contacted', 'replied'] as const) expect(statusAfterSync(s)).toBe(s)
  })

  it('formats the score breakdown one rule per line', () => {
    expect(formatBreakdown(60, BREAKDOWN)).toBe(
      'Total 60/100 (scoring v1)\nhandles_custody: 40/40 (handles custody: yes)\nfirm_size: 20/20 (size band: small)',
    )
    expect(formatBreakdown(null, null)).toBeUndefined()
  })

  it('builds §10 properties with the post-sync status, omitting empty values', () => {
    expect(companyVeroxaProps(firm())).toMatchObject({ veroxa_fit_score: '60', pipeline_status: 'synced', lead_source: 'manual_csv' })
    expect(companyVeroxaProps(firm({ fit_score: null, custody_evidence_url: null, score_breakdown: null }))).toEqual({ pipeline_status: 'synced', lead_source: 'manual_csv' })
  })

  it('sets standard fields (and owner) only in create props', () => {
    expect(companyCreateOnlyProps(firm(), '777')).toEqual({ name: 'Harbor Family Law', domain: 'harborfamily.com', city: 'Toms River', state: 'NJ', numberofemployees: '7', hubspot_owner_id: '777' })
    expect(companyCreateOnlyProps(firm({ headcount_est: null }))).not.toHaveProperty('numberofemployees')
  })

  it('splits names: last word is the last name, suffixes stay with it, Esq. is dropped', () => {
    expect(splitName('Dana R. Whitlock, Esq.')).toEqual({ firstname: 'Dana R.', lastname: 'Whitlock' })
    expect(splitName('Morgan Lee Castellano')).toEqual({ firstname: 'Morgan Lee', lastname: 'Castellano' })
    expect(splitName('Robert T. Hale Jr.')).toEqual({ firstname: 'Robert T.', lastname: 'Hale Jr.' })
    expect(splitName('Madonna')).toEqual({ firstname: 'Madonna' })
    expect(splitName(null)).toEqual({})
    expect(contactCreateProps(contact(), firm())).toEqual({ email: 'dwhitlock@harborfamily.com', firstname: 'Dana R.', lastname: 'Whitlock', jobtitle: 'Partner', company: 'Harbor Family Law' })
  })

  it('skips contacts that are held, suppressed, unsubscribed, not the decision-maker, or unverified', () => {
    expect(contactEligibility(contact(), undefined)).toEqual({ ok: true })
    expect(contactEligibility(contact({ email: null }), undefined)).toMatchObject({ reason: 'no_email' })
    expect(contactEligibility(contact(), { email: 'x', reason: 'manual', source: 'hold:confirm_jr' })).toMatchObject({ reason: 'held' })
    expect(contactEligibility(contact(), { email: 'x', reason: 'bounced', source: 'm7' })).toMatchObject({ reason: 'suppressed', detail: 'bounced (m7)' })
    expect(contactEligibility(contact({ unsubscribed: true }), undefined)).toMatchObject({ reason: 'unsubscribed' })
    expect(contactEligibility(contact({ is_decision_maker: false }), undefined)).toMatchObject({ reason: 'not_decision_maker' })
    expect(contactEligibility(contact({ email_verified: false }), undefined)).toMatchObject({ reason: 'unverified' })
    // held beats not-a-decision-maker
    expect(contactEligibility(contact({ is_decision_maker: false }), { email: 'x', reason: 'manual', source: 'hold:y' })).toMatchObject({ reason: 'held' })
  })
})

function rec(props: Record<string, string | null>, history: Record<string, { value: string; timestamp: string; sourceType: string; sourceId?: string }[]> = {}): RecordWithHistory {
  return { id: '500', properties: props, history }
}

describe('decideCompanyWrites (conflict detection)', () => {
  const ours = new Set([OURS])

  it('writes changed values and skips unchanged ones', () => {
    const current = rec({ veroxa_fit_score: '60', pipeline_status: 'qualified' }, {
      veroxa_fit_score: [{ value: '60', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }],
      pipeline_status: [{ value: 'qualified', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }],
    })
    const d = decideCompanyWrites({ veroxa_fit_score: '60', pipeline_status: 'synced' }, current, ours)
    expect(d).toEqual({ write: { pipeline_status: 'synced' }, unchanged: ['veroxa_fit_score'], conflicts: [] })
  })

  it('never overwrites a value last edited by a person in HubSpot', () => {
    const current = rec({ veroxa_fit_score: '90' }, {
      veroxa_fit_score: [
        { value: '90', timestamp: T1, sourceType: 'CRM_UI', sourceId: 'userid:1' },
        { value: '60', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS },
      ],
    })
    const d = decideCompanyWrites({ veroxa_fit_score: '70' }, current, ours)
    expect(d.write).toEqual({})
    expect(d.conflicts).toEqual([{ property: 'veroxa_fit_score', hubspotValue: '90', wanted: '70', editedBy: 'CRM_UI', editedAt: T1 }])
  })

  it('keeps the conflict on later runs, however old the manual edit is', () => {
    // The manual edit is older than any later last_synced_at, but still the newest entry.
    const current = rec({ lead_source: 'referral' }, { lead_source: [{ value: 'referral', timestamp: T0, sourceType: 'CRM_UI' }] })
    expect(decideCompanyWrites({ lead_source: 'manual_csv' }, current, ours).conflicts).toHaveLength(1)
  })

  it("treats another integration's write as a conflict once we know our source ID", () => {
    const current = rec({ lead_source: 'zapier' }, { lead_source: [{ value: 'zapier', timestamp: T1, sourceType: 'INTEGRATION', sourceId: '999' }] })
    expect(decideCompanyWrites({ lead_source: 'manual_csv' }, current, ours).conflicts).toHaveLength(1)
  })

  it('is not a conflict when the manual value already matches Supabase', () => {
    const current = rec({ lead_source: 'manual_csv' }, { lead_source: [{ value: 'manual_csv', timestamp: T1, sourceType: 'CRM_UI' }] })
    expect(decideCompanyWrites({ lead_source: 'manual_csv' }, current, ours)).toEqual({ write: {}, unchanged: ['lead_source'], conflicts: [] })
  })

  it('learns our source ID from entries stamped exactly at last_synced_at', () => {
    const r = rec({}, { veroxa_fit_score: [{ value: '60', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }], lead_source: [{ value: 'x', timestamp: T1, sourceType: 'INTEGRATION', sourceId: '999' }] })
    expect([...learnOurSourceIds([r], new Map([['500', T0]]))]).toEqual([OURS])
    expect(learnOurSourceIds([r], new Map([['500', null]])).size).toBe(0)
  })
})

// HubSpot fake keyed by endpoint.
function fakeHubSpot(opts: { companiesByDomain?: Record<string, string[]>; records?: Record<string, RecordWithHistory>; contactsByEmail?: Record<string, string> } = {}) {
  const calls: { method: string; url: string; body: any }[] = []
  let nextId = 900
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined
    const method = init.method ?? 'GET'
    calls.push({ method, url, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    if (url.endsWith('/companies/search')) {
      const values: string[] = body.filterGroups[0].filters[0].values
      return json({ results: values.flatMap((d) => (opts.companiesByDomain?.[d] ?? []).map((id) => ({ id, properties: { domain: d } }))) })
    }
    if (url.endsWith('/companies/batch/read')) {
      const results = body.inputs
        .filter((i: { id: string }) => opts.records?.[i.id])
        .map((i: { id: string }) => ({ id: i.id, properties: opts.records![i.id]!.properties, propertiesWithHistory: opts.records![i.id]!.history }))
      return json({ results })
    }
    if (url.endsWith('/contacts/search')) {
      const values: string[] = body.filterGroups[0].filters[0].values
      return json({ results: values.filter((e) => opts.contactsByEmail?.[e]).map((e) => ({ id: opts.contactsByEmail![e], properties: { email: e } })) })
    }
    if (url.endsWith('/batch/create')) {
      return json({ results: body.inputs.map((i: any) => ({ id: String(nextId++), properties: i.properties, createdAt: T1, updatedAt: T1 })) }, 201)
    }
    if (url.endsWith('/batch/update')) return json({ results: body.inputs.map((i: any) => ({ id: i.id, properties: i.properties, updatedAt: T1 })) })
    if (method === 'PUT') return json({})
    return json({ results: [] })
  })
  const client = createHubSpotClient({ serviceKey: 'k', fetch: fn as unknown as typeof fetch, retry: { sleep: async () => {} } })
  return { client, calls }
}

const input = (over: Partial<SyncInput> = {}): SyncInput => ({ firms: [firm()], contacts: [contact()], suppressions: new Map(), ...over })

describe('planSync', () => {
  it('creates a company and contact that are not in HubSpot yet', async () => {
    const hs = fakeHubSpot()
    const plan = await planSync(hs.client, input(), { ownerId: '777' })
    expect(plan.companies).toHaveLength(1)
    expect(plan.companies[0]).toMatchObject({ kind: 'create', properties: { name: 'Harbor Family Law', hubspot_owner_id: '777', pipeline_status: 'synced' } })
    expect(plan.contacts[0]).toMatchObject({ kind: 'create', properties: { email: 'dwhitlock@harborfamily.com', hubspot_owner_id: '777' } })
    expect(hs.calls.every((c) => /search|batch\/read/.test(c.url))).toBe(true) // planning only reads
  })

  it('links an existing company found by domain without touching its standard fields', async () => {
    const hs = fakeHubSpot({ companiesByDomain: { 'harborfamily.com': ['300', '301'] }, records: { '300': rec({ name: 'Their Name' }) } })
    const plan = await planSync(hs.client, input())
    const a = plan.companies[0]!
    expect(a).toMatchObject({ kind: 'update', hubspotId: '300', how: 'domain_match', duplicateIds: ['301'] })
    if (a.kind === 'update') expect(Object.keys(a.writes.write)).not.toContain('name')
  })

  it('uses the stored company ID, and relinks by domain if HubSpot no longer has it', async () => {
    const stored = fakeHubSpot({ records: { '400': rec({}) } })
    const p1 = await planSync(stored.client, input({ firms: [firm({ hubspot_company_id: '400', last_synced_at: T0 })] }))
    expect(p1.companies[0]).toMatchObject({ kind: 'update', hubspotId: '400', how: 'stored_id' })
    expect(stored.calls.some((c) => c.url.endsWith('/companies/search'))).toBe(false)

    const gone = fakeHubSpot({ companiesByDomain: { 'harborfamily.com': ['401'] }, records: { '401': rec({}) } })
    const p2 = await planSync(gone.client, input({ firms: [firm({ hubspot_company_id: '400' })] }))
    expect(p2.staleIds).toEqual([{ firm: expect.objectContaining({ id: 'f1' }), storedId: '400' }])
    expect(p2.companies[0]).toMatchObject({ hubspotId: '401', how: 'domain_match' })
  })

  it('links a contact that already exists in HubSpot and skips ineligible ones', async () => {
    const hs = fakeHubSpot({ contactsByEmail: { 'dwhitlock@harborfamily.com': '77' } })
    const plan = await planSync(
      hs.client,
      input({
        contacts: [contact(), contact({ id: 'c2', email: 'held@harborfamily.com' }), contact({ id: 'c3', email: 'para@harborfamily.com', is_decision_maker: false })],
        suppressions: new Map([['held@harborfamily.com', { email: 'held@harborfamily.com', reason: 'manual', source: 'hold:check' }]]),
      }),
    )
    expect(plan.contacts).toEqual([expect.objectContaining({ kind: 'link', hubspotId: '77' })])
    expect(plan.skipped.map((s) => [s.contact.id, s.reason])).toEqual([['c2', 'held'], ['c3', 'not_decision_maker']])
  })
})

describe('executeSync', () => {
  it('creates, stores IDs and HubSpot timestamps back, moves qualified to synced, and associates', async () => {
    const hs = fakeHubSpot()
    const fdb = fakeDb({ f1: 'qualified' })
    const plan = await planSync(hs.client, input({ contacts: [contact(), contact({ id: 'c9', email: 'x@harborfamily.com', is_decision_maker: false })] }))
    const s = await executeSync(fdb.db, hs.client, plan, quiet)

    expect(s).toMatchObject({ companiesCreated: 1, contactsCreated: 1, statusChanged: 1, skippedLogged: 1 })
    expect(fdb.updates).toContainEqual({ table: 'firms', values: { hubspot_company_id: '900', last_synced_at: T1 }, id: 'f1' })
    expect(fdb.updates).toContainEqual({ table: 'contacts', values: { hubspot_contact_id: '901', last_synced_at: T1 }, id: 'c1' })
    expect(fdb.firmStatus.get('f1')).toBe('synced')
    expect(hs.calls.find((c) => c.method === 'PUT')!.url).toContain('/contact/901/associations/default/company/900')
    expect(fdb.events.map((e) => e.type)).toEqual(expect.arrayContaining(['hubspot_company_synced', 'status_changed', 'hubspot_contact_synced', 'hubspot_skipped']))
  })

  it('logs each skipped contact once, not on every run', async () => {
    const hs = fakeHubSpot()
    const fdb = fakeDb({ f1: 'qualified' })
    const plan = await planSync(hs.client, input({ contacts: [contact({ is_decision_maker: false })] }))
    await executeSync(fdb.db, hs.client, plan, quiet)
    const second = await executeSync(fdb.db, hs.client, plan, quiet)
    expect(second.skippedLogged).toBe(0)
    expect(fdb.events.filter((e) => e.type === 'hubspot_skipped')).toHaveLength(1)
  })

  it('writes only non-conflicting changes and keeps last_synced_at on our own write', async () => {
    const hs = fakeHubSpot({
      records: {
        '400': rec({ veroxa_fit_score: '99', pipeline_status: 'qualified' }, {
          veroxa_fit_score: [{ value: '99', timestamp: T1, sourceType: 'CRM_UI' }, { value: '60', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }],
          pipeline_status: [{ value: 'qualified', timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }],
        }),
      },
    })
    const fdb = fakeDb({ f1: 'synced' })
    const plan = await planSync(hs.client, input({ firms: [firm({ status: 'synced', hubspot_company_id: '400', last_synced_at: T0 })], contacts: [] }))
    const s = await executeSync(fdb.db, hs.client, plan, quiet)

    const update = hs.calls.find((c) => c.url.endsWith('/companies/batch/update'))!
    expect(update.body.inputs[0].properties).not.toHaveProperty('veroxa_fit_score')
    expect(update.body.inputs[0].properties).toMatchObject({ pipeline_status: 'synced' })
    expect(s.conflicts).toEqual([{ firm: 'Harbor Family Law', conflicts: [expect.objectContaining({ property: 'veroxa_fit_score', hubspotValue: '99' })] }])
    expect(fdb.updates).toContainEqual({ table: 'firms', values: { hubspot_company_id: '400', last_synced_at: T1 }, id: 'f1' })
  })

  it('writes nothing to HubSpot when everything is current, and keeps the old last_synced_at', async () => {
    const f = firm({ status: 'synced', hubspot_company_id: '400', last_synced_at: T0 })
    const want = companyVeroxaProps(f)
    const history = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, [{ value: v, timestamp: T0, sourceType: 'INTEGRATION', sourceId: OURS }]]))
    const hs = fakeHubSpot({ records: { '400': rec(want, history) } })
    const fdb = fakeDb({ f1: 'synced' })
    const s = await executeSync(fdb.db, hs.client, await planSync(hs.client, input({ firms: [f], contacts: [] })), quiet)
    expect(s.companiesUnchanged).toBe(1)
    expect(hs.calls.some((c) => c.url.endsWith('/batch/update') || c.url.endsWith('/batch/create'))).toBe(false)
    expect(fdb.updates).toContainEqual({ table: 'firms', values: { hubspot_company_id: '400', last_synced_at: T0 }, id: 'f1' })
  })
})
