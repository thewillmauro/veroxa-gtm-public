import { describe, expect, it } from 'vitest'
import { appendEvent, setFirmStatus } from '../src/lib/events.js'
import type { Db } from '../src/lib/db.js'

// Just enough of the supabase-js query builder for the events helpers.
function fakeDb(opts: { insertError?: { code: string; message: string }; status?: string } = {}) {
  const calls: { table: string; op: string; value?: unknown }[] = []
  const db = {
    from(table: string) {
      const chain: any = {
        insert(value: unknown) { calls.push({ table, op: 'insert', value }); return chain },
        update(value: unknown) { calls.push({ table, op: 'update', value }); return chain },
        select() { return chain },
        eq() { return chain },
        single: async () => {
          if (table === 'pipeline_events') {
            return opts.insertError ? { data: null, error: opts.insertError } : { data: { id: 42 }, error: null }
          }
          return { data: { status: opts.status ?? 'new' }, error: null }
        },
        then(resolve: (v: unknown) => void) { resolve({ error: null }) },
      }
      return chain
    },
  }
  return { db: db as unknown as Db, calls }
}

describe('appendEvent', () => {
  it('inserts and returns the new id', async () => {
    const { db, calls } = fakeDb()
    await expect(appendEvent(db, { entity: 'firm', entityId: 'f1', type: 'seeded' })).resolves.toEqual({ inserted: true, id: 42 })
    expect(calls[0]).toMatchObject({ table: 'pipeline_events', op: 'insert', value: { entity: 'firm', entity_id: 'f1', type: 'seeded', idempotency_key: null } })
  })

  it('treats a duplicate idempotency key as a no-op, not an error', async () => {
    const { db } = fakeDb({ insertError: { code: '23505', message: 'duplicate key' } })
    await expect(appendEvent(db, { entity: 'firm', type: 'clay_callback_received', idempotencyKey: 'k' })).resolves.toEqual({ inserted: false, reason: 'duplicate' })
  })

  it('throws on other errors', async () => {
    const { db } = fakeDb({ insertError: { code: '42501', message: 'permission denied' } })
    await expect(appendEvent(db, { entity: 'firm', type: 'x' })).rejects.toThrow(/permission denied/)
  })
})

describe('setFirmStatus', () => {
  it('updates the firm and records from/to in the audit log', async () => {
    const { db, calls } = fakeDb({ status: 'new' })
    await setFirmStatus(db, 'f1', 'sent_to_clay', { reason: 'batch' })
    expect(calls.map((c) => `${c.table}.${c.op}`)).toEqual(['firms.update', 'pipeline_events.insert'])
    expect(calls[1]!.value).toMatchObject({ type: 'status_changed', payload: { from: 'new', to: 'sent_to_clay', reason: 'batch' } })
  })

  it('does nothing when the status is unchanged', async () => {
    const { db, calls } = fakeDb({ status: 'enriched' })
    await setFirmStatus(db, 'f1', 'enriched')
    expect(calls).toHaveLength(0)
  })
})
