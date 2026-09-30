import { describe, expect, it, vi } from 'vitest'
import { createHubSpotClient } from '../../src/hubspot/client.js'
import { ensureAttorneyPilot, FALLBACK_PREFIX, findAttorneyPilot, PIPELINE_LABEL, STAGES } from '../../src/hubspot/pipeline.js'
import { dealName, planReply, recordReply, type ReplyTarget } from '../../src/hubspot/reply.js'
import { fakeDb } from './fake-db.js'

const DEFAULT_STAGES = [{ id: 's1', label: 'Appointment Scheduled', displayOrder: 0 }]
const ownStages = STAGES.map((s, i) => ({ id: `p${i}`, label: s.label, displayOrder: i }))

function fakeHubSpot(handler: (method: string, url: string, body: any) => { status: number; body?: unknown }) {
  const calls: { method: string; url: string; body: any }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({ method, url, body })
    const r = handler(method, url, body)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status })
  })
  return { client: createHubSpotClient({ serviceKey: 'k', fetch: fn as unknown as typeof fetch, retry: { sleep: async () => {} } }), calls }
}

describe('findAttorneyPilot', () => {
  it('finds our own pipeline', () => {
    const r = findAttorneyPilot([{ id: 'default', label: 'Deals pipeline', stages: DEFAULT_STAGES }, { id: '77', label: PIPELINE_LABEL, stages: ownStages }])
    expect(r).toMatchObject({ mode: 'own', pipelineId: '77', stageIds: { replied: 'p0', lost: 'p4' } })
  })

  it('finds prefixed stages on the default pipeline (Free plan fallback)', () => {
    const stages = [...DEFAULT_STAGES, ...STAGES.map((s, i) => ({ id: `d${i}`, label: `${FALLBACK_PREFIX}${s.label}` }))]
    expect(findAttorneyPilot([{ id: 'default', label: 'Deals pipeline', stages }])).toMatchObject({ mode: 'default', pipelineId: 'default', stageIds: { replied: 'd0' } })
  })

  it('returns null until every stage exists', () => {
    expect(findAttorneyPilot([{ id: '77', label: PIPELINE_LABEL, stages: ownStages.slice(0, 2) }])).toBeNull()
  })
})

describe('ensureAttorneyPilot', () => {
  it('creates its own pipeline when the plan allows', async () => {
    let created = false
    const hs = fakeHubSpot((method) => {
      if (method === 'POST') {
        created = true
        return { status: 201, body: {} }
      }
      return { status: 200, body: { results: [{ id: 'default', label: 'Deals pipeline', stages: DEFAULT_STAGES }, ...(created ? [{ id: '77', label: PIPELINE_LABEL, stages: ownStages }] : [])] } }
    })
    const r = await ensureAttorneyPilot(hs.client, { apply: true })
    expect(r).toMatchObject({ status: 'created', resolved: { mode: 'own' } })
  })

  it('falls back to prefixed stages on the default pipeline when HubSpot refuses a second pipeline', async () => {
    const added: string[] = []
    const hs = fakeHubSpot((method, url, body) => {
      if (method === 'POST' && url.endsWith('/pipelines/deals')) return { status: 403, body: { message: 'You have reached the maximum number of pipelines for your subscription' } }
      if (method === 'POST') {
        added.push(body.label)
        return { status: 201, body: {} }
      }
      const stages = [...DEFAULT_STAGES, ...added.map((label, i) => ({ id: `d${i}`, label }))]
      return { status: 200, body: { results: [{ id: 'default', label: 'Deals pipeline', stages }] } }
    })
    const r = await ensureAttorneyPilot(hs.client, { apply: true })
    expect(r).toMatchObject({ status: 'created', resolved: { mode: 'default' } })
    expect(added).toEqual(STAGES.map((s) => `${FALLBACK_PREFIX}${s.label}`))
  })

  it('does nothing in a dry run, and nothing when it already exists', async () => {
    const empty = fakeHubSpot(() => ({ status: 200, body: { results: [{ id: 'default', label: 'Deals pipeline', stages: DEFAULT_STAGES }] } }))
    expect((await ensureAttorneyPilot(empty.client, { apply: false })).status).toBe('missing')
    expect(empty.calls.every((c) => c.method === 'GET')).toBe(true)

    const done = fakeHubSpot(() => ({ status: 200, body: { results: [{ id: '77', label: PIPELINE_LABEL, stages: ownStages }] } }))
    expect((await ensureAttorneyPilot(done.client, { apply: true })).status).toBe('exists')
    expect(done.calls.every((c) => c.method === 'GET')).toBe(true)
  })
})

const target = (over: Partial<ReplyTarget['firm']> = {}, contact: ReplyTarget['contact'] = { id: 'c1', email: 'a@x.com', hubspot_contact_id: '71' }): ReplyTarget => ({
  firm: { id: 'f1', name: 'Harbor Family Law', status: 'synced', hubspot_company_id: '500', hubspot_deal_id: null, ...over },
  contact,
  source: 'manual',
  sourceRef: 'a@x.com',
})

const pipelines = { results: [{ id: '77', label: PIPELINE_LABEL, stages: ownStages }] }

describe('reply flow', () => {
  it('refuses a firm that is not in HubSpot yet', () => {
    expect(planReply(target({ hubspot_company_id: null }))).toMatchObject({ ok: false })
    expect(planReply(target())).toMatchObject({ ok: true, deal: 'create', dealName: 'Harbor Family Law - Attorney Pilot' })
    expect(planReply(target({ hubspot_deal_id: '9' }))).toMatchObject({ ok: true, deal: 'exists' })
  })

  it('creates one deal in the Replied stage, associated with company and contact, and marks the firm replied', async () => {
    const hs = fakeHubSpot((method, url) => {
      if (url.endsWith('/pipelines/deals')) return { status: 200, body: pipelines }
      if (url.endsWith('/deals/search')) return { status: 200, body: { results: [] } }
      if (method === 'POST' && url.endsWith('/objects/deals')) return { status: 201, body: { id: '8001' } }
      return { status: 200, body: {} }
    })
    const fdb = fakeDb({ f1: 'synced' })
    const plan = planReply(target())
    if (!plan.ok) throw new Error('expected ok')
    expect(await recordReply(fdb.db, hs.client, plan, { ownerId: '777' })).toEqual({ dealId: '8001', created: true })

    const create = hs.calls.find((c) => c.method === 'POST' && c.url.endsWith('/objects/deals'))!
    expect(create.body.properties).toEqual({ dealname: dealName('Harbor Family Law'), pipeline: '77', dealstage: 'p0', hubspot_owner_id: '777' })
    expect(create.body.associations.map((a: any) => [a.to.id, a.types[0].associationTypeId])).toEqual([['500', 5], ['71', 3]])
    expect(fdb.updates).toContainEqual({ table: 'firms', values: { hubspot_deal_id: '8001' }, id: 'f1' })
    expect(fdb.firmStatus.get('f1')).toBe('replied')
    expect(fdb.events.find((e) => e.type === 'contact_replied')!.idempotency_key).toBe('contact_replied:c1')
  })

  it('reuses a deal found by name instead of creating a duplicate', async () => {
    const hs = fakeHubSpot((_m, url) =>
      url.endsWith('/pipelines/deals') ? { status: 200, body: pipelines } : url.endsWith('/deals/search') ? { status: 200, body: { results: [{ id: '8000' }] } } : { status: 200, body: {} },
    )
    const fdb = fakeDb({ f1: 'synced' })
    const plan = planReply(target())
    if (!plan.ok) throw new Error('expected ok')
    expect(await recordReply(fdb.db, hs.client, plan)).toEqual({ dealId: '8000', created: false })
    expect(hs.calls.some((c) => c.method === 'POST' && c.url.endsWith('/objects/deals'))).toBe(false)
  })

  it('does not touch HubSpot when the firm already has a deal, and logs the reply once', async () => {
    const hs = fakeHubSpot(() => ({ status: 500 }))
    const fdb = fakeDb({ f1: 'replied' })
    const plan = planReply(target({ hubspot_deal_id: '8000', status: 'replied' }))
    if (!plan.ok) throw new Error('expected ok')
    await recordReply(fdb.db, hs.client, plan)
    await recordReply(fdb.db, hs.client, plan)
    expect(hs.calls).toHaveLength(0)
    expect(fdb.events.filter((e) => e.type === 'contact_replied')).toHaveLength(1)
  })

  it('links the deal to the company only when the contact is not in HubSpot', async () => {
    const hs = fakeHubSpot((method, url) =>
      url.endsWith('/pipelines/deals') ? { status: 200, body: pipelines } : url.endsWith('/deals/search') ? { status: 200, body: { results: [] } } : method === 'POST' ? { status: 201, body: { id: '8002' } } : { status: 200, body: {} },
    )
    const plan = planReply(target({}, { id: 'c1', email: 'a@x.com', hubspot_contact_id: null }))
    if (!plan.ok) throw new Error('expected ok')
    await recordReply(fakeDb({ f1: 'synced' }).db, hs.client, plan)
    const create = hs.calls.find((c) => c.method === 'POST' && c.url.endsWith('/objects/deals'))!
    expect(create.body.associations).toHaveLength(1)
  })
})
