import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHubSpotClient, HubSpotBatchError, HubSpotError, parseRetryAfter } from '../../src/hubspot/client.js'
import { associateContactToCompany, upsertCompanies, upsertContact, upsertContacts } from '../../src/hubspot/crm.js'

const KEY = 'pat-test-key-never-printed'

interface FakeReply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

// Replies in order; the last reply repeats. Records every request.
function fakeFetch(replies: FakeReply[] | ((url: string, init: RequestInit) => FakeReply)) {
  const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> })
    const r = typeof replies === 'function' ? replies(url, init) : replies[Math.min(calls.length - 1, replies.length - 1)]!
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers ?? {} })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

function client(f: ReturnType<typeof fakeFetch>, sleeps: number[] = []) {
  return createHubSpotClient({
    serviceKey: KEY,
    fetch: f.fetch,
    now: () => Date.parse('2026-09-29T12:00:00Z'),
    retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
  })
}

const MISSING_SCOPES = {
  status: 'error',
  message: "This app hasn't been granted all required scopes to make this call.",
  correlationId: 'abc-123',
  category: 'MISSING_SCOPES',
  errors: [{ message: 'One or more of the following scopes are required.', context: { requiredGranularScopes: ['crm.objects.owners.read'] } }],
}

describe('HubSpot transport', () => {
  it('sends the key as a Bearer header and parses the response with the schema', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }])
    await expect(client(f).request('GET', '/x', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true })
    expect(f.calls[0]!.url).toBe('https://api.hubapi.com/x')
    expect(f.calls[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it("surfaces HubSpot's message, category and missing scopes, without the key", async () => {
    const f = fakeFetch([{ status: 403, body: MISSING_SCOPES }])
    const err = await client(f).request('GET', '/crm/v3/owners', z.unknown()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubSpotError)
    const e = err as HubSpotError
    expect(e.status).toBe(403)
    expect(e.category).toBe('MISSING_SCOPES')
    expect(e.correlationId).toBe('abc-123')
    expect(e.requiredScopes).toEqual(['crm.objects.owners.read'])
    expect(e.message).toContain("hasn't been granted")
    expect(e.message).toContain('missing scopes: crm.objects.owners.read')
    expect(e.message).not.toContain(KEY)
    expect(f.calls).toHaveLength(1) // 403 is not retried
  })

  it('falls back to raw text for non-JSON error pages', async () => {
    const f = fakeFetch([{ status: 400, body: '<html>bad</html>' }])
    await expect(client(f).request('GET', '/x', z.unknown())).rejects.toThrow('returned 400: <html>bad</html>')
  })

  it('retries 429 and 5xx, honoring Retry-After seconds', async () => {
    const sleeps: number[] = []
    const f = fakeFetch([{ status: 429, headers: { 'retry-after': '3' } }, { status: 502 }, { status: 200, body: {} }])
    await client(f, sleeps).request('GET', '/x', z.unknown())
    expect(f.calls).toHaveLength(3)
    expect(sleeps[0]).toBe(3000) // server-requested wait, not backoff
    expect(sleeps[1]).toBe(0) // no Retry-After: jittered backoff (random() = 0)
  })

  it('gives up after 4 attempts and throws the last HubSpotError', async () => {
    const f = fakeFetch([{ status: 503, body: { message: 'down' } }])
    await expect(client(f).request('GET', '/x', z.unknown())).rejects.toThrow('returned 503: down')
    expect(f.calls).toHaveLength(4)
  })

  it('never retries a non-idempotent POST on 5xx (it may have succeeded), but does on 429', async () => {
    const five = fakeFetch([{ status: 500 }, { status: 200, body: {} }])
    await expect(client(five).request('POST', '/create', z.unknown())).rejects.toBeInstanceOf(HubSpotError)
    expect(five.calls).toHaveLength(1)

    const rate = fakeFetch([{ status: 429 }, { status: 200, body: {} }])
    await client(rate).request('POST', '/create', z.unknown())
    expect(rate.calls).toHaveLength(2)

    const idem = fakeFetch([{ status: 500 }, { status: 200, body: {} }])
    await client(idem).request('POST', '/search', z.unknown(), { idempotent: true })
    expect(idem.calls).toHaveLength(2)
  })

  it('rejects a response that fails the schema', async () => {
    const f = fakeFetch([{ status: 200, body: { results: 'nope' } }])
    await expect(client(f).request('GET', '/x', z.object({ results: z.array(z.unknown()) }))).rejects.toThrow('unexpected response shape')
  })

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-09-29T12:00:00Z')
    expect(parseRetryAfter('10', now)).toBe(10_000)
    expect(parseRetryAfter('Tue, 29 Sep 2026 12:00:05 GMT', now)).toBe(5_000)
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(parseRetryAfter('soon', now)).toBeUndefined()
  })
})

describe('upsertContacts', () => {
  it('batch-upserts by normalized, deduped email', async () => {
    const f = fakeFetch([{ status: 200, body: { results: [{ id: '101', new: false, properties: { email: 'jane@firm.com' } }] } }])
    const res = await upsertContacts(client(f), [
      { email: ' Jane@Firm.com ', properties: { firstname: 'J' } },
      { email: 'jane@firm.com', properties: { lastname: 'Doe' } },
    ])
    expect(res).toEqual([{ id: '101', key: 'jane@firm.com', created: false }])
    expect(f.calls[0]!.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert')
    expect(f.calls[0]!.body).toEqual({
      inputs: [{ idProperty: 'email', id: 'jane@firm.com', properties: { firstname: 'J', lastname: 'Doe', email: 'jane@firm.com' } }],
    })
  })

  it('sets the owner only on newly created contacts', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('/batch/upsert')
        ? { status: 200, body: { results: [{ id: '1', new: true, properties: { email: 'a@x.com' } }, { id: '2', new: false, properties: { email: 'b@x.com' } }] } }
        : { status: 200, body: { results: [] } },
    )
    await upsertContacts(client(f), [{ email: 'a@x.com' }, { email: 'b@x.com' }], { ownerId: '777' })
    expect(f.calls[1]!.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/batch/update')
    expect(f.calls[1]!.body).toEqual({ inputs: [{ id: '1', properties: { hubspot_owner_id: '777' } }] })
  })

  it('splits more than 100 inputs into batches of 100', async () => {
    const f = fakeFetch((_url, init) => {
      const inputs = JSON.parse(init.body as string).inputs as { id: string }[]
      return { status: 200, body: { results: inputs.map((i, n) => ({ id: String(n), properties: { email: i.id } })) } }
    })
    const emails = Array.from({ length: 150 }, (_, i) => ({ email: `p${i}@x.com` }))
    const res = await upsertContacts(client(f), emails)
    expect(f.calls.map((c) => c.body.inputs.length)).toEqual([100, 50])
    expect(res).toHaveLength(150)
  })

  it('throws HubSpotBatchError with partial results on per-input errors', async () => {
    const f = fakeFetch([
      { status: 207, body: { results: [{ id: '1', properties: { email: 'a@x.com' } }], errors: [{ message: 'Property "bogus" does not exist', category: 'VALIDATION_ERROR' }] } },
    ])
    const err = await upsertContact(client(f), { email: 'a@x.com', properties: { bogus: '1' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubSpotBatchError)
    expect((err as HubSpotBatchError).message).toContain('Property "bogus" does not exist')
    expect((err as HubSpotBatchError).partialResults).toHaveLength(1)
  })

  it('rejects an invalid email before calling HubSpot', async () => {
    const f = fakeFetch([{ status: 200, body: {} }])
    await expect(upsertContact(client(f), { email: 'not-an-email' })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
})

describe('upsertCompanies', () => {
  it('updates companies found by domain, creates the rest with the owner, and reports duplicates', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/search')) {
        return {
          status: 200,
          body: {
            results: [
              { id: '10', properties: { domain: 'old.com' } },
              { id: '11', properties: { domain: 'old.com' } },
            ],
          },
        }
      }
      if (url.endsWith('/batch/create')) return { status: 201, body: { results: [{ id: '20', properties: { domain: 'new.com' } }] } }
      return { status: 200, body: { results: [] } }
    })
    const res = await upsertCompanies(
      client(f),
      [
        { domain: 'https://www.Old.com/about', properties: { name: 'Old LLP' } },
        { domain: 'new.com', properties: { name: 'New LLP' } },
      ],
      { ownerId: '777' },
    )

    const search = f.calls[0]!
    expect(search.body.filterGroups[0].filters[0]).toEqual({ propertyName: 'domain', operator: 'IN', values: ['old.com', 'new.com'] })
    expect(search.body.sorts).toEqual([{ propertyName: 'createdate', direction: 'ASCENDING' }])

    const update = f.calls.find((c) => c.url.endsWith('/batch/update'))!
    expect(update.body).toEqual({ inputs: [{ id: '10', properties: { name: 'Old LLP' } }] }) // oldest match; no owner change

    const create = f.calls.find((c) => c.url.endsWith('/batch/create'))!
    expect(create.body).toEqual({ inputs: [{ properties: { name: 'New LLP', domain: 'new.com', hubspot_owner_id: '777' } }] })

    expect(res).toEqual([
      { id: '10', key: 'old.com', created: false, duplicateIds: ['11'] },
      { id: '20', key: 'new.com', created: true },
    ])
  })

  it('follows search paging', async () => {
    let searches = 0
    const f = fakeFetch((url) => {
      if (!url.endsWith('/search')) return { status: 200, body: { results: [] } }
      searches++
      return searches === 1
        ? { status: 200, body: { results: [{ id: '1', properties: { domain: 'a.com' } }], paging: { next: { after: '1' } } } }
        : { status: 200, body: { results: [{ id: '2', properties: { domain: 'b.com' } }] } }
    })
    const res = await upsertCompanies(client(f), [{ domain: 'a.com' }, { domain: 'b.com' }])
    expect(f.calls[1]!.body.after).toBe('1')
    expect(res.map((r) => r.id)).toEqual(['1', '2'])
    expect(f.calls.some((c) => c.url.endsWith('/batch/update'))).toBe(false) // no properties to write
  })

  it('does not retry a company create on 5xx (it may have gone through)', async () => {
    const f = fakeFetch((url) => (url.endsWith('/search') ? { status: 200, body: { results: [] } } : { status: 502 }))
    await expect(upsertCompanies(client(f), [{ domain: 'x.com' }])).rejects.toBeInstanceOf(HubSpotError)
    expect(f.calls.filter((c) => c.url.endsWith('/batch/create'))).toHaveLength(1)
  })
})

describe('associateContactToCompany', () => {
  it('PUTs the default contact-to-company association', async () => {
    const f = fakeFetch([{ status: 200, body: { status: 'COMPLETE' } }])
    await associateContactToCompany(client(f), '101', '202')
    expect(f.calls[0]!.method).toBe('PUT')
    expect(f.calls[0]!.url).toBe('https://api.hubapi.com/crm/v4/objects/contact/101/associations/default/company/202')
  })

  it('rejects non-numeric IDs before building a URL', async () => {
    const f = fakeFetch([{ status: 200 }])
    await expect(associateContactToCompany(client(f), '../owners', '1')).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
  })
})
