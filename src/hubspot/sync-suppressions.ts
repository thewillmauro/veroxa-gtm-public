// Mirror GTM suppressions to HubSpot contact properties.
//
// Supabase `suppressions` is the do-not-pitch list (ADR 0003); HubSpot gets
// a copy so nobody working a contact there emails someone who opted out.
// Rules:
//   - Only contacts that already exist in HubSpot are updated. Never creates.
//   - existing_customer is skipped: it means "don't pitch", not "opted out".
//   - Best effort: each batch of 100 is independent; a failed batch is
//     reported and the rest still run. The HubSpot client retries 429/5xx.
//   - Removing a suppression doesn't clear the HubSpot flag (not needed yet).

import type { Db } from '../lib/db.js'
import type { Logger } from '../lib/logger.js'
import { BATCH_SIZE, findContactsByEmail, updateContacts, type FoundContact, type Properties } from './crm.js'
import type { HubSpotClient } from './client.js'
import { OPT_OUT_REASONS, type OptOutReason } from './properties.js'

export const MIRRORED_REASONS: readonly OptOutReason[] = OPT_OUT_REASONS

const MIRROR_PROPERTIES = ['veroxa_email_opt_out', 'veroxa_opt_out_reason', 'veroxa_opt_out_at'] as const

export interface Suppression {
  email: string
  reason: OptOutReason
  created_at: string
}

export function desiredProperties(s: Suppression): Properties {
  return {
    veroxa_email_opt_out: 'true',
    veroxa_opt_out_reason: s.reason,
    veroxa_opt_out_at: new Date(s.created_at).toISOString(),
  }
}

function isCurrent(want: Properties, have: Record<string, string | null>): boolean {
  if (have['veroxa_email_opt_out'] !== want['veroxa_email_opt_out']) return false
  if (have['veroxa_opt_out_reason'] !== want['veroxa_opt_out_reason']) return false
  const haveAt = have['veroxa_opt_out_at']
  // HubSpot may return the datetime in another ISO form (e.g. no millis).
  return !!haveAt && Date.parse(haveAt) === Date.parse(want['veroxa_opt_out_at']!)
}

export interface SuppressionPlan {
  updates: { id: string; email: string; properties: Properties }[]
  notInHubSpot: string[]
  alreadyCurrent: string[]
}

/** Pure: decide which HubSpot contacts need their opt-out properties written. */
export function planSuppressionUpdates(suppressions: Suppression[], found: Map<string, FoundContact>): SuppressionPlan {
  const plan: SuppressionPlan = { updates: [], notInHubSpot: [], alreadyCurrent: [] }
  for (const s of suppressions) {
    const contact = found.get(s.email)
    if (!contact) {
      plan.notInHubSpot.push(s.email)
      continue
    }
    const want = desiredProperties(s)
    if (isCurrent(want, contact.properties)) plan.alreadyCurrent.push(s.email)
    else plan.updates.push({ id: contact.id, email: s.email, properties: want })
  }
  return plan
}

export async function loadMirroredSuppressions(db: Db): Promise<Suppression[]> {
  const out: Suppression[] = []
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from('suppressions')
      .select('email, reason, created_at')
      .in('reason', [...MIRRORED_REASONS])
      .order('email')
      .range(from, from + page - 1)
    if (error) throw new Error(`load suppressions: ${error.message}`)
    for (const row of data) {
      if ((MIRRORED_REASONS as readonly string[]).includes(row.reason)) {
        out.push({ email: row.email, reason: row.reason as OptOutReason, created_at: row.created_at })
      }
    }
    if (data.length < page) break
  }
  return out
}

export interface SyncSummary {
  considered: number
  updated: string[]
  wouldUpdate: string[]
  alreadyCurrent: number
  notInHubSpot: number
  failed: { emails: string[]; error: string }[]
}

export async function syncSuppressionsToHubSpot(
  suppressions: Suppression[],
  client: HubSpotClient,
  options: { apply: boolean; log: Logger },
): Promise<SyncSummary> {
  const summary: SyncSummary = { considered: suppressions.length, updated: [], wouldUpdate: [], alreadyCurrent: 0, notInHubSpot: 0, failed: [] }

  for (let i = 0; i < suppressions.length; i += BATCH_SIZE) {
    const batch = suppressions.slice(i, i + BATCH_SIZE)
    try {
      const found = await findContactsByEmail(client, batch.map((s) => s.email), [...MIRROR_PROPERTIES])
      const plan = planSuppressionUpdates(batch, found)
      summary.alreadyCurrent += plan.alreadyCurrent.length
      summary.notInHubSpot += plan.notInHubSpot.length
      if (!plan.updates.length) continue

      if (!options.apply) {
        summary.wouldUpdate.push(...plan.updates.map((u) => u.email))
        continue
      }
      await updateContacts(client, plan.updates)
      summary.updated.push(...plan.updates.map((u) => u.email))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      options.log.warn('hubspot suppression batch failed', { batchStart: i, size: batch.length, error: message })
      summary.failed.push({ emails: batch.map((s) => s.email), error: message })
    }
  }
  return summary
}
