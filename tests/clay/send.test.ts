import { describe, expect, it, vi } from 'vitest'
import { HttpError, postToClay, sendFirmsToClay, type EligibleFirm } from '../../src/clay/send.js'
import { main } from '../../src/clay/cli.js'
import { createLogger } from '../../src/lib/logger.js'
import type { Db } from '../../src/lib/db.js'

const FIRM: EligibleFirm = { id: '0b6f3c1e-8d2a-4c5b-9e7f-1a2b3c4d5e6f', name: 'Smith & Rivera Family Law', domain: 'smithrivera.com', city: 'Red Bank', state: 'NJ' }
const FIRM2: EligibleFirm = { ...FIRM, id: '1c7f4d2f-9e3b-4d6c-8f80-2b3c4d5e6f70', domain: 'other.com' }
const quiet = createLogger({ write: () => {} })
const noWait = { sleep: () => Promise.resolve() }

function fakeFetch(statuses: number[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!
    return new Response(status >= 400 ? 'nope' : '{}', { status })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

// Records the writes the send path makes.
function fakeDb() {
  const writes: string[] = []
  const db = {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (v: any) => { writes.push(`${table}.insert:${v.type}`); return chain },
        update: (v: any) => { writes.push(`${table}.update:${v.status}`); return chain },
        single: async () => (table === 'firms' ? { data: { status: 'new' }, error: null } : { data: { id: 1 }, error: null }),
        then: (resolve: any) => resolve({ error: null }),
      }
      return chain
    },
  }
  return { db: db as unknown as Db, writes }
}

describe('postToClay', () => {
  it('POSTs the §7 payload as JSON, with the auth header only when configured', async () => {
    const f = fakeFetch([200])
    await postToClay({ firm_id: FIRM.id, name: FIRM.name, domain: 'smithrivera.com', city: 'Red Bank', state: 'NJ', callback_secret_ref: 'v1' }, { url: 'https://api.clay.com/hook', fetch: f.fetch })
    expect(f.calls[0]!.url).toBe('https://api.clay.com/hook')
    expect(f.calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(f.calls[0]!.init.body as string)).toMatchObject({ firm_id: FIRM.id, callback_secret_ref: 'v1' })
    expect(f.calls[0]!.init.headers).not.toHaveProperty('x-clay-webhook-auth')

    const g = fakeFetch([200])
    await postToClay({ firm_id: FIRM.id, name: 'x', domain: 'x.com', city: null, state: null, callback_secret_ref: 'v1' }, { url: 'https://api.clay.com/hook', authToken: 't', fetch: g.fetch })
    expect(g.calls[0]!.init.headers).toHaveProperty('x-clay-webhook-auth', 't')
  })

  it('retries 429/5xx and gives up immediately on other 4xx', async () => {
    const retry = fakeFetch([429, 503, 200])
    await expect(postToClay({} as any, { url: 'https://api.clay.com/h', fetch: retry.fetch, retry: noWait })).resolves.toBe(200)
    expect(retry.calls).toHaveLength(3)

    const fatal = fakeFetch([400])
    await expect(postToClay({} as any, { url: 'https://api.clay.com/h', fetch: fatal.fetch, retry: noWait })).rejects.toBeInstanceOf(HttpError)
    expect(fatal.calls).toHaveLength(1)
  })
})

describe('sendFirmsToClay', () => {
  it('marks sent firms sent_to_clay and logs failures without changing status', async () => {
    const { db, writes } = fakeDb()
    let n = 0
    const f = vi.fn(async () => new Response('', { status: n++ === 0 ? 200 : 400 })) as unknown as typeof fetch
    const result = await sendFirmsToClay(db, [FIRM, FIRM2], { url: 'https://api.clay.com/h', fetch: f, retry: noWait }, quiet)
    expect(result.sent.map((s) => s.firmId)).toEqual([FIRM.id])
    expect(result.failed.map((s) => s.firmId)).toEqual([FIRM2.id])
    expect(writes).toEqual(['firms.update:sent_to_clay', 'pipeline_events.insert:status_changed', 'pipeline_events.insert:clay_send_failed'])
  })
})

describe('clay:send cli', () => {
  it('rejects bad arguments before touching config', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main(['--limit', '0'])).toBe(2)
    expect(await main(['--limit', '101'])).toBe(2)
    expect(await main(['--firm', 'nope'])).toBe(2)
    err.mockRestore()
  })

  it('refuses --send without a Clay webhook URL, and to a non-Clay host', async () => {
    const saved = { ...process.env }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
    delete process.env.CLAY_WEBHOOK_URL
    expect(await main(['--send'])).toBe(2)
    process.env.CLAY_WEBHOOK_URL = 'https://evil.example.com/hook'
    expect(await main(['--send'])).toBe(2)
    expect(err.mock.calls.flat().join('\n')).toMatch(/not a Clay domain/)
    err.mockRestore()
    process.env = saved
  })
})
