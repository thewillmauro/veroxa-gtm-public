// Run a job only if no other run of it holds the lease (job_locks table,
// migration 20260929120000). The lease expires after ttlSeconds so a
// crashed run can't block the job forever; keep ttl above the job's
// worst-case runtime, or a second run could start while the first is
// still going.

import { randomUUID } from 'node:crypto'
import type { Db } from './db.js'

/** Every job that writes to HubSpot takes this one lock, so syncs never overlap. */
export const HUBSPOT_SYNC_LOCK = 'hubspot-sync'

export type LockedResult<T> = { ran: true; value: T } | { ran: false }

export async function withJobLock<T>(
  db: Db,
  name: string,
  fn: () => Promise<T>,
  options: { ttlSeconds?: number } = {},
): Promise<LockedResult<T>> {
  const holder = randomUUID()
  const { data: acquired, error } = await db.rpc('acquire_job_lock', {
    p_name: name,
    p_holder: holder,
    p_ttl_seconds: options.ttlSeconds ?? 900,
  })
  if (error) throw new Error(`acquire_job_lock(${name}) failed: ${error.message}`)
  if (!acquired) return { ran: false }

  try {
    return { ran: true, value: await fn() }
  } finally {
    // Best effort: if this fails, the lease expires on its own.
    await db.rpc('release_job_lock', { p_name: name, p_holder: holder })
  }
}
