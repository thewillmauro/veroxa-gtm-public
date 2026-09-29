// HTTP contract of the clay-callback function, exercised through the same
// handler the Deno entry point uses, with the database faked.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleClayCallback, secretMatches, type ApplyResult, type CallbackDeps } from '../../supabase/functions/clay-callback/handler.ts'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'clay')
const raw = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
const SECRET = 'current-secret-0123456789abcdef'
const PREVIOUS = 'previous-secret-0123456789abcdef'
const FIRM_ID = '0b6f3c1e-8d2a-4c5b-9e7f-1a2b3c4d5e6f'

function harness(applyResult: ApplyResult = { result: 'applied', status_from: 'sent_to_clay', status_to: 'enriched', contacts_upserted: 1, contacts_owned_by_other_firm: [] }) {
  const applied: Parameters<CallbackDeps['apply']>[0][] = []
  const rejected: Parameters<CallbackDeps['logRejected']>[0][] = []
  const deps: CallbackDeps = {
    secrets: [SECRET, PREVIOUS],
    apply: async (input) => {
      applied.push(input)
      return applyResult
    },
    logRejected: async (input) => void rejected.push(input),
  }
  const call = (body: string, init: { secret?: string | null; method?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers }
    const secret = init.secret === undefined ? SECRET : init.secret
    if (secret !== null) headers['x-veroxa-secret'] = secret
    const method = init.method ?? 'POST'
    return handleClayCallback(
      new Request('https://example.supabase.co/functions/v1/clay-callback', { method, headers, ...(method === 'GET' ? {} : { body }) }),
      deps,
    )
  }
  return { deps, applied, rejected, call }
}

describe('clay-callback handler', () => {
  it('applies the SPEC §7 payload and returns the result', async () => {
    const h = harness()
    const res = await h.call(raw('callback.spec.json'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: 'applied', firm_id: FIRM_ID, contacts_upserted: 1, people_dropped: 0 })
    expect(h.applied).toHaveLength(1)
    expect(h.applied[0]!.idempotencyKey).toMatch(new RegExp(`^clay_callback:${FIRM_ID}:[0-9a-f]{64}$`))
    expect(h.applied[0]!.raw).toEqual(JSON.parse(raw('callback.spec.json')))
    expect(h.rejected).toHaveLength(0)
  })

  it('rejects a missing or wrong secret with 401 before reading the body', async () => {
    for (const secret of [null, '', 'wrong', SECRET + 'x']) {
      const h = harness()
      const res = await h.call('this is not json', { secret })
      expect(res.status, String(secret)).toBe(401)
      expect(h.applied).toHaveLength(0)
      expect(h.rejected).toHaveLength(0) // unauthenticated input is never stored
    }
  })

  describe('transient database errors', () => {
    const noSleep = () => Promise.resolve()

    it('retries "JWT issued at future" (platform clock skew) and succeeds', async () => {
      const h = harness()
      let calls = 0
      const applied = h.deps.apply
      h.deps.sleep = noSleep
      h.deps.apply = async (input) => {
        calls++
        if (calls === 1) throw new Error('apply_clay_callback failed: JWT issued at future')
        return applied(input)
      }
      const res = await h.call(raw('callback.spec.json'))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ result: 'applied' })
      expect(calls).toBe(2)
    })

    it('uses the same idempotency key on every attempt', async () => {
      const h = harness()
      const keys: string[] = []
      h.deps.sleep = noSleep
      h.deps.apply = async (input) => {
        keys.push(input.idempotencyKey)
        if (keys.length < 3) throw new Error('fetch failed')
        return { result: 'duplicate' }
      }
      expect((await h.call(raw('callback.spec.json'))).status).toBe(200)
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(1)
    })

    it('gives up after 3 attempts on a persistent transient error', async () => {
      const h = harness()
      let calls = 0
      h.deps.sleep = noSleep
      h.deps.apply = async () => {
        calls++
        throw new Error('apply_clay_callback failed: JWT issued at future')
      }
      await expect(h.call(raw('callback.spec.json'))).rejects.toThrow(/JWT issued at future/)
      expect(calls).toBe(3)
    })

    it('does not retry a non-transient error', async () => {
      const h = harness()
      let calls = 0
      h.deps.sleep = noSleep
      h.deps.apply = async () => {
        calls++
        throw new Error('apply_clay_callback failed: violates check constraint "firms_firm_size_band_check"')
      }
      await expect(h.call(raw('callback.spec.json'))).rejects.toThrow(/check constraint/)
      expect(calls).toBe(1)
    })
  })

  it('accepts the previous secret during rotation', async () => {
    const res = await harness().call(raw('callback.spec.json'), { secret: PREVIOUS })
    expect(res.status).toBe(200)
  })

  it('fails closed when no secret is configured', async () => {
    const h = harness()
    h.deps.secrets = ['', '']
    expect((await h.call(raw('callback.spec.json'), { secret: '' })).status).toBe(500)
  })

  it('uses the same idempotency key for the same payload regardless of key order or whitespace', async () => {
    const h = harness()
    const body = JSON.parse(raw('callback.spec.json'))
    const reordered = JSON.stringify({ people: body.people, custody: body.custody, company: body.company, firm_id: body.firm_id }, null, 4)
    await h.call(raw('callback.spec.json'))
    await h.call(reordered)
    expect(h.applied[0]!.idempotencyKey).toBe(h.applied[1]!.idempotencyKey)
  })

  it('uses a different key when the payload content changes', async () => {
    const h = harness()
    const body = JSON.parse(raw('callback.spec.json'))
    await h.call(JSON.stringify(body))
    await h.call(JSON.stringify({ ...body, company: { headcount: 7 } }))
    expect(h.applied[0]!.idempotencyKey).not.toBe(h.applied[1]!.idempotencyKey)
  })

  it('returns 200 duplicate when the database has already seen the payload', async () => {
    const res = await harness({ result: 'duplicate' }).call(raw('callback.spec.json'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ result: 'duplicate' })
  })

  it('returns 422 and logs a rejection when a research email is off the firm domain', async () => {
    const h = harness({ result: 'research_email_domain_mismatch', firm_domain: 'jdwhitfieldlaw-example.com', emails: ['jennifer@whitfieldmd-example.com'] })
    const res = await h.call(raw('callback.dm.json'))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'research_email_domain_mismatch', details: [expect.stringMatching(/jdwhitfieldlaw-example\.com.*jennifer@whitfieldmd-example\.com/)] })
    expect(h.rejected).toEqual([expect.objectContaining({ reason: 'research_email_domain_mismatch', firmId: FIRM_ID })])
  })

  it('returns 404 and logs a rejection for an unknown firm', async () => {
    const h = harness({ result: 'unknown_firm' })
    const res = await h.call(raw('callback.spec.json'))
    expect(res.status).toBe(404)
    expect(h.rejected).toEqual([expect.objectContaining({ reason: 'unknown_firm', firmId: null })])
  })

  it('returns 422 with field errors and logs the raw payload for invalid input', async () => {
    const h = harness()
    const res = await h.call(raw('callback.invalid.json'))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe('validation_failed')
    expect(body.details.length).toBeGreaterThan(0)
    expect(h.applied).toHaveLength(0)
    expect(h.rejected[0]).toMatchObject({ reason: 'validation_failed', firmId: null, raw: JSON.parse(raw('callback.invalid.json')) })
  })

  it('returns 400 for a body that is not JSON', async () => {
    const h = harness()
    const res = await h.call('{"firm_id": ')
    expect(res.status).toBe(400)
    expect(h.rejected[0]).toMatchObject({ reason: 'invalid_json' })
  })

  it('returns 413 for an oversized body', async () => {
    const h = harness()
    const big = JSON.stringify({ firm_id: FIRM_ID, company: { description: 'x'.repeat(300 * 1024) } })
    expect((await h.call(big)).status).toBe(413)
    expect((await h.call('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } })).status).toBe(413)
    expect(h.applied).toHaveLength(0)
  })

  it('returns 405 for non-POST methods', async () => {
    expect((await harness().call('', { method: 'GET' })).status).toBe(405)
  })

  it('reports dropped people in the response', async () => {
    const res = await harness().call(raw('callback.messy-people.json'))
    expect(await res.json()).toMatchObject({ people_dropped: 3 })
  })
})

describe('secretMatches', () => {
  it('matches only exact secrets and ignores empty configured values', async () => {
    expect(await secretMatches(SECRET, ['', SECRET])).toBe(true)
    expect(await secretMatches('', [''])).toBe(false)
    expect(await secretMatches(null, [SECRET])).toBe(false)
    expect(await secretMatches(SECRET.toUpperCase(), [SECRET])).toBe(false)
  })
})
