// Minimal Supabase stand-in for HubSpot sync tests: records updates and
// events, answers setFirmStatus's status read, and enforces unique
// idempotency keys on pipeline_events like the real table.

import type { Db } from '../../src/lib/db.js'

export interface FakeDb {
  db: Db
  updates: { table: string; values: Record<string, unknown>; id: unknown }[]
  events: { type: string; entity_id: unknown; payload: any; idempotency_key: string | null }[]
  firmStatus: Map<string, string>
}

export function fakeDb(firmStatus: Record<string, string> = {}): FakeDb {
  const state: FakeDb = { db: undefined as unknown as Db, updates: [], events: [], firmStatus: new Map(Object.entries(firmStatus)) }
  const keys = new Set<string>()

  const from = (table: string) => {
    let op: 'select' | 'update' | 'insert' = 'select'
    let values: any
    let id: unknown
    const chain: any = {
      select: () => chain,
      order: () => chain,
      in: () => chain,
      not: () => chain,
      eq: (_col: string, v: unknown) => {
        id = v
        return chain
      },
      update: (v: any) => {
        op = 'update'
        values = v
        return chain
      },
      insert: (v: any) => {
        op = 'insert'
        values = v
        return chain
      },
      single: async () => {
        if (op === 'insert' && table === 'pipeline_events') {
          if (values.idempotency_key && keys.has(values.idempotency_key)) return { data: null, error: { code: '23505', message: 'duplicate' } }
          if (values.idempotency_key) keys.add(values.idempotency_key)
          state.events.push(values)
          return { data: { id: state.events.length }, error: null }
        }
        if (table === 'firms') return { data: { status: state.firmStatus.get(String(id)) }, error: null }
        return { data: null, error: null }
      },
      then: (resolve: any) => {
        if (op === 'update') {
          state.updates.push({ table, values, id })
          if (table === 'firms' && typeof values.status === 'string') state.firmStatus.set(String(id), values.status)
        }
        return resolve({ data: [], error: null })
      },
    }
    return chain
  }
  state.db = { from } as unknown as Db
  return state
}
