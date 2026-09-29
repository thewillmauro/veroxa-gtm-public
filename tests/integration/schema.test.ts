// Runs against the real linked project. Skipped unless both env vars are
// set: `npm run test:integration` loads them from .env.
//
// Every row it writes is tagged with source/entity 'integration_test' and
// cleaned up, except pipeline_events rows, which are append-only by design.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDb, type Db } from '../../src/lib/db.js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey = process.env.SUPABASE_ANON_KEY
const enabled = Boolean(url && serviceKey)

describe.skipIf(!enabled)('schema (live)', () => {
  let db: Db
  const domain = `it-${Date.now()}.example.com`

  beforeAll(() => {
    db = createDb({ SUPABASE_URL: url!, SUPABASE_SERVICE_ROLE_KEY: serviceKey! })
  })

  afterAll(async () => {
    await db.from('firms').delete().eq('domain', domain)
  })

  it('round-trips a firm and bumps updated_at on update', async () => {
    const { data: firm, error } = await db.from('firms').insert({ name: 'IT Firm', domain, source: 'integration_test' }).select().single()
    expect(error).toBeNull()
    expect(firm!.status).toBe('new')

    await new Promise((r) => setTimeout(r, 20))
    const { data: updated } = await db.from('firms').update({ status: 'sent_to_clay' }).eq('id', firm!.id).select().single()
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(firm!.updated_at).getTime())
  })

  it('rejects a mixed-case domain', async () => {
    const { error } = await db.from('firms').insert({ name: 'x', domain: 'Mixed.Example.com', source: 'integration_test' })
    expect(error?.code).toBe('23514')
  })

  it('makes pipeline_events append-only', async () => {
    const { data: ev } = await db.from('pipeline_events').insert({ entity: 'system', type: 'integration_test' }).select('id').single()
    const { error: updErr } = await db.from('pipeline_events').update({ type: 'tampered' }).eq('id', ev!.id)
    expect(updErr?.message).toMatch(/append-only/)
    const { error: delErr } = await db.from('pipeline_events').delete().eq('id', ev!.id)
    expect(delErr?.message).toMatch(/append-only/)
  })

  it.skipIf(!anonKey)('denies the anon key', async () => {
    const anon = createClient(url!, anonKey!, { auth: { persistSession: false } })
    const { error } = await anon.from('firms').select('id').limit(1)
    expect(error?.code).toBe('42501')
  })
})
