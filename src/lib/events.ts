// Every state change appends a row to pipeline_events. Status changes go
// through setFirmStatus so the audit trail can't be skipped by accident.

import { createHash } from 'node:crypto'
import type { Db, PipelineStatus } from './db.js'
import type { Json } from './database.types.js'
import { canonicalJson } from '../../supabase/functions/_shared/canonical-json.ts'

export { canonicalJson }

export type EventEntity = 'firm' | 'contact' | 'research' | 'draft' | 'inbound' | 'suppression' | 'system'

export interface AppendEventInput {
  entity: EventEntity
  entityId?: string | null
  type: string
  payload?: Json
  /** Set to make the event (and the work it records) idempotent. */
  idempotencyKey?: string
}

export type AppendEventResult = { inserted: true; id: number } | { inserted: false; reason: 'duplicate' }

const UNIQUE_VIOLATION = '23505'

export async function appendEvent(db: Db, input: AppendEventInput): Promise<AppendEventResult> {
  const { data, error } = await db
    .from('pipeline_events')
    .insert({
      entity: input.entity,
      entity_id: input.entityId ?? null,
      type: input.type,
      payload: input.payload ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === UNIQUE_VIOLATION && input.idempotencyKey) return { inserted: false, reason: 'duplicate' }
    throw new Error(`appendEvent(${input.type}) failed: ${error.message}`)
  }
  return { inserted: true, id: data.id }
}

export async function setFirmStatus(
  db: Db,
  firmId: string,
  to: PipelineStatus,
  context: { reason?: string; payload?: Json } = {},
): Promise<void> {
  const { data: before, error: readErr } = await db.from('firms').select('status').eq('id', firmId).single()
  if (readErr) throw new Error(`setFirmStatus: firm ${firmId} not found: ${readErr.message}`)
  if (before.status === to) return

  const { error } = await db.from('firms').update({ status: to }).eq('id', firmId)
  if (error) throw new Error(`setFirmStatus(${firmId} -> ${to}) failed: ${error.message}`)

  await appendEvent(db, {
    entity: 'firm',
    entityId: firmId,
    type: 'status_changed',
    payload: { from: before.status, to, reason: context.reason ?? null, detail: context.payload ?? null },
  })
}

/** Stable hash for idempotency keys: key order in objects does not matter. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
