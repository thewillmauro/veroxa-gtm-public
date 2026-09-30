import { describe, expect, it, vi } from 'vitest'
import { createHubSpotClient } from '../../src/hubspot/client.js'
import { COMPANY_PROPERTIES, CONTACT_PROPERTIES, ensureProperties, formatForUi, propertyMismatches } from '../../src/hubspot/properties.js'

function fakeFetch(handler: (method: string, url: string) => { status: number; body?: unknown }) {
  const calls: { method: string; url: string; body: any }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, body: init.body ? JSON.parse(init.body as string) : undefined })
    const r = handler(method, url)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const client = (f: ReturnType<typeof fakeFetch>) =>
  createHubSpotClient({ serviceKey: 'k', fetch: f.fetch, retry: { sleep: async () => {} } })

const byName = (name: string) => CONTACT_PROPERTIES.find((p) => p.name === name)!

describe('contact property definitions', () => {
  it('defines the three opt-out properties with the requested types', () => {
    expect(CONTACT_PROPERTIES.map((p) => [p.name, p.type, p.fieldType])).toEqual([
      ['veroxa_email_opt_out', 'bool', 'booleancheckbox'],
      ['veroxa_opt_out_reason', 'enumeration', 'select'],
      ['veroxa_opt_out_at', 'datetime', 'date'],
    ])
    expect(byName('veroxa_opt_out_reason').options!.map((o) => o.value)).toEqual(['unsubscribed', 'bounced', 'complaint', 'manual'])
  })

  it('flags type, field type and missing enum options', () => {
    const reason = byName('veroxa_opt_out_reason')
    expect(propertyMismatches(reason, { name: reason.name, type: 'enumeration', fieldType: 'select', options: [{ value: 'unsubscribed' }, { value: 'bounced' }, { value: 'complaint' }, { value: 'manual' }] })).toEqual([])
    expect(propertyMismatches(reason, { name: reason.name, type: 'string', fieldType: 'text', options: [{ value: 'bounced' }] })).toEqual([
      'type is string, want enumeration',
      'fieldType is text, want select',
      'missing options: unsubscribed, complaint, manual',
    ])
  })

  it('prints UI instructions with the exact internal name and options', () => {
    const text = formatForUi(byName('veroxa_opt_out_reason'))
    expect(text).toContain('Internal name:  veroxa_opt_out_reason')
    expect(text).toContain('Dropdown select')
    expect(text).toContain('Complaint -> complaint')
  })
})

describe('company property definitions', () => {
  it('defines the SPEC §10 company properties', () => {
    expect(COMPANY_PROPERTIES.map((p) => [p.name, p.type, p.fieldType])).toEqual([
      ['veroxa_fit_score', 'number', 'number'],
      ['veroxa_score_breakdown', 'string', 'textarea'],
      ['custody_evidence_url', 'string', 'text'],
      ['pipeline_status', 'enumeration', 'select'],
      ['lead_source', 'string', 'text'],
    ])
  })

  it('takes pipeline_status options from the DB enum', () => {
    const values = COMPANY_PROPERTIES.find((p) => p.name === 'pipeline_status')!.options!.map((o) => o.value)
    expect(values).toContain('qualified')
    expect(values).toContain('synced')
    expect(values).toContain('replied')
  })

  it('prints company UI instructions', () => {
    const text = formatForUi(COMPANY_PROPERTIES[0]!, 'companies')
    expect(text).toContain('Object:         Company')
    expect(text).toContain('Field type:     Number')
  })
})

describe('ensureProperties', () => {
  it('uses the object type in the property URLs', async () => {
    const f = fakeFetch((method) => (method === 'GET' ? { status: 404 } : { status: 201, body: {} }))
    await ensureProperties(client(f), 'companies', { apply: true }, [COMPANY_PROPERTIES[0]!])
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://api.hubapi.com/crm/v3/properties/companies/veroxa_fit_score',
      'POST https://api.hubapi.com/crm/v3/properties/companies',
    ])
  })

  const [optOut, reason] = CONTACT_PROPERTIES as [(typeof CONTACT_PROPERTIES)[0], (typeof CONTACT_PROPERTIES)[0]]

  it('creates only missing properties, and only with apply', async () => {
    const handler = (method: string, url: string) =>
      method === 'GET' && url.endsWith('/veroxa_email_opt_out')
        ? { status: 200, body: { name: 'veroxa_email_opt_out', type: 'bool', fieldType: 'booleancheckbox', options: [] } }
        : method === 'GET'
          ? { status: 404, body: { message: 'not found' } }
          : { status: 201, body: {} }

    const dry = fakeFetch(handler)
    expect(await ensureProperties(client(dry), 'contacts', { apply: false }, [optOut, reason])).toEqual([
      { name: 'veroxa_email_opt_out', status: 'exists' },
      { name: 'veroxa_opt_out_reason', status: 'missing' },
    ])
    expect(dry.calls.some((c) => c.method === 'POST')).toBe(false)

    const wet = fakeFetch(handler)
    expect(await ensureProperties(client(wet), 'contacts', { apply: true }, [optOut, reason])).toEqual([
      { name: 'veroxa_email_opt_out', status: 'exists' },
      { name: 'veroxa_opt_out_reason', status: 'created' },
    ])
    const posts = wet.calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body.name).toBe('veroxa_opt_out_reason')
  })

  it('reports a refusal (missing scope) instead of throwing', async () => {
    const f = fakeFetch((method) =>
      method === 'GET'
        ? { status: 404 }
        : { status: 403, body: { category: 'MISSING_SCOPES', message: 'missing', errors: [{ context: { requiredGranularScopes: ['crm.schemas.contacts.write'] } }] } },
    )
    const [outcome] = await ensureProperties(client(f), 'contacts', { apply: true }, [optOut])
    expect(outcome!.status).toBe('refused')
    expect(outcome!.status === 'refused' && outcome!.error.requiredScopes).toEqual(['crm.schemas.contacts.write'])
  })

  it('never modifies a mismatched existing property', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { name: 'veroxa_email_opt_out', type: 'string', fieldType: 'text' } }))
    const [outcome] = await ensureProperties(client(f), 'contacts', { apply: true }, [optOut])
    expect(outcome!.status).toBe('mismatch')
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('treats a 409 on create as already existing (race with another run)', async () => {
    const f = fakeFetch((method) => (method === 'GET' ? { status: 404 } : { status: 409, body: { message: 'exists' } }))
    expect(await ensureProperties(client(f), 'contacts', { apply: true }, [optOut])).toEqual([{ name: 'veroxa_email_opt_out', status: 'exists' }])
  })
})
