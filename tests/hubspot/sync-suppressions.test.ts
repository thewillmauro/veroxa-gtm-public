import { describe, expect, it, vi } from 'vitest'
import { createHubSpotClient } from '../../src/hubspot/client.js'
import type { FoundContact } from '../../src/hubspot/crm.js'
import {
  desiredProperties,
  loadMirroredSuppressions,
  MIRRORED_REASONS,
  planSuppressionUpdates,
  syncSuppressionsToHubSpot,
  type Suppression,
} from '../../src/hubspot/sync-suppressions.js'
import { withJobLock } from '../../src/lib/job-lock.js'
import { createLogger } from '../../src/lib/logger.js'
import type { Db } from '../../src/lib/db.js'

const quiet = createLogger({ write: () => {} })
const AT = '2026-09-20T10:00:00.000Z'
const sup = (email: string, reason: Suppression['reason'] = 'unsubscribed'): Suppression => ({ email, reason, created_at: AT })

describe('planSuppressionUpdates', () => {
  it('mirrors only reasons that mean opted out, never existing_customer', () => {
    expect([...MIRRORED_REASONS]).toEqual(['unsubscribed', 'bounced', 'complaint', 'manual'])
    expect(MIRRORED_REASONS).not.toContain('existing_customer')
  })

  it('skips emails not in HubSpot, skips contacts already current, updates the rest', () => {
    const found = new Map<string, FoundContact>([
      ['current@x.com', { id: '1', properties: { veroxa_email_opt_out: 'true', veroxa_opt_out_reason: 'bounced', veroxa_opt_out_at: '2026-09-20T10:00:00Z' } }],
      ['stale@x.com', { id: '2', properties: { veroxa_email_opt_out: 'true', veroxa_opt_out_reason: 'unsubscribed', veroxa_opt_out_at: AT } }],
      ['blank@x.com', { id: '3', properties: { veroxa_email_opt_out: null } }],
    ])
    const plan = planSuppressionUpdates(
      [sup('current@x.com', 'bounced'), sup('stale@x.com', 'complaint'), sup('blank@x.com'), sup('absent@x.com')],
      found,
    )
    expect(plan.notInHubSpot).toEqual(['absent@x.com'])
    expect(plan.alreadyCurrent).toEqual(['current@x.com']) // same instant, different ISO form
    expect(plan.updates).toEqual([
      { id: '2', email: 'stale@x.com', properties: desiredProperties(sup('stale@x.com', 'complaint')) },
      { id: '3', email: 'blank@x.com', properties: desiredProperties(sup('blank@x.com')) },
    ])
    expect(desiredProperties(sup('a@x.com', 'manual'))).toEqual({ veroxa_email_opt_out: 'true', veroxa_opt_out_reason: 'manual', veroxa_opt_out_at: AT })
  })
})

// HubSpot fake: contacts that "exist" are returned by search; records every call.
function fakeHubSpot(existing: Record<string, string>, opts: { failSearchCall?: number } = {}) {
  const calls: { url: string; body: any }[] = []
  let searches = 0
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, body })
    if (url.endsWith('/contacts/search')) {
      searches++
      if (searches === opts.failSearchCall) return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 })
      const values: string[] = body.filterGroups[0].filters[0].values
      const results = values.filter((e) => existing[e]).map((e) => ({ id: existing[e], properties: { email: e } }))
      return new Response(JSON.stringify({ results }), { status: 200 })
    }
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  const client = createHubSpotClient({ serviceKey: 'k', fetch: fn as unknown as typeof fetch, retry: { sleep: async () => {} } })
  return { client, calls }
}

describe('syncSuppressionsToHubSpot', () => {
  it('dry run reads but never writes', async () => {
    const hs = fakeHubSpot({ 'a@x.com': '1' })
    const s = await syncSuppressionsToHubSpot([sup('a@x.com'), sup('b@x.com')], hs.client, { apply: false, log: quiet })
    expect(s.wouldUpdate).toEqual(['a@x.com'])
    expect(s.notInHubSpot).toBe(1)
    expect(hs.calls.every((c) => c.url.endsWith('/search'))).toBe(true)
  })

  it('updates existing contacts by ID and never creates or upserts', async () => {
    const hs = fakeHubSpot({ 'a@x.com': '1' })
    const s = await syncSuppressionsToHubSpot([sup('a@x.com', 'bounced'), sup('parent@x.com')], hs.client, { apply: true, log: quiet })
    expect(s.updated).toEqual(['a@x.com'])
    expect(hs.calls.some((c) => /batch\/(create|upsert)$/.test(c.url) || c.url.endsWith('/objects/contacts'))).toBe(false)
    const update = hs.calls.find((c) => c.url.endsWith('/contacts/batch/update'))!
    expect(update.body).toEqual({ inputs: [{ id: '1', properties: desiredProperties(sup('a@x.com', 'bounced')) }] })
  })

  it('keeps going after a failed batch and reports it', async () => {
    const existing = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`p${i}@x.com`, String(i + 1)]))
    const hs = fakeHubSpot(existing, { failSearchCall: 1 })
    const s = await syncSuppressionsToHubSpot(Object.keys(existing).map((e) => sup(e)), hs.client, { apply: true, log: quiet })
    expect(s.failed).toHaveLength(1)
    expect(s.failed[0]!.emails).toHaveLength(100)
    expect(s.failed[0]!.error).toContain('bad request')
    expect(s.updated).toHaveLength(50)
  })
})

describe('loadMirroredSuppressions', () => {
  it('asks the DB for mirrored reasons only and drops anything else defensively', async () => {
    const inCalls: unknown[][] = []
    const rows = [
      { email: 'a@x.com', reason: 'unsubscribed', created_at: AT },
      { email: 'cust@x.com', reason: 'existing_customer', created_at: AT },
    ]
    const chain: any = {
      select: () => chain,
      in: (...args: unknown[]) => { inCalls.push(args); return chain },
      order: () => chain,
      range: async () => ({ data: rows, error: null }),
    }
    const db = { from: () => chain } as unknown as Db
    expect(await loadMirroredSuppressions(db)).toEqual([sup('a@x.com')])
    expect(inCalls[0]).toEqual(['reason', ['unsubscribed', 'bounced', 'complaint', 'manual']])
  })
})

describe('withJobLock', () => {
  function fakeDb(acquired: boolean) {
    const rpcs: { fn: string; args: any }[] = []
    const db = {
      rpc: vi.fn(async (fn: string, args: any) => {
        rpcs.push({ fn, args })
        return { data: fn === 'acquire_job_lock' ? acquired : true, error: null }
      }),
    } as unknown as Db
    return { db, rpcs }
  }

  it('runs the job and releases the lease with the same holder', async () => {
    const { db, rpcs } = fakeDb(true)
    expect(await withJobLock(db, 'hubspot-sync', async () => 42)).toEqual({ ran: true, value: 42 })
    expect(rpcs.map((r) => r.fn)).toEqual(['acquire_job_lock', 'release_job_lock'])
    expect(rpcs[1]!.args.p_holder).toBe(rpcs[0]!.args.p_holder)
  })

  it('skips the job when another run holds the lease', async () => {
    const { db, rpcs } = fakeDb(false)
    const job = vi.fn(async () => 1)
    expect(await withJobLock(db, 'hubspot-sync', job)).toEqual({ ran: false })
    expect(job).not.toHaveBeenCalled()
    expect(rpcs.map((r) => r.fn)).toEqual(['acquire_job_lock'])
  })

  it('releases the lease even when the job throws', async () => {
    const { db, rpcs } = fakeDb(true)
    await expect(withJobLock(db, 'hubspot-sync', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(rpcs.map((r) => r.fn)).toEqual(['acquire_job_lock', 'release_job_lock'])
  })
})
