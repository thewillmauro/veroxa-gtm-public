// Reply flow (SPEC §10: a deal is created only when a contact replies).
//
// A reply is recorded one of two ways:
//   - by hand: `npm run reply -- --email <address>` when someone answers
//     outreach (cold mail is sent by hand, so there's no inbox to watch);
//   - from a signup: an inbound_signups row matched to a pipeline firm
//     (ADR 0002) counts as a reply from that firm.
// Either way: the firm moves to `replied`, a contact_replied event is
// appended (idempotent), and one deal per firm is created in the Attorney
// Pilot "Replied" stage, associated with the company and the contact.
// The firm's HubSpot pipeline_status catches up on the next hubspot:sync.

import { z } from 'zod'
import type { Db } from '../lib/db.js'
import { appendEvent, setFirmStatus } from '../lib/events.js'
import { normalizeEmail } from '../lib/email.js'
import type { HubSpotClient } from './client.js'
import { resolveAttorneyPilot } from './pipeline.js'

// HubSpot-defined association type IDs (deal -> contact, deal -> company).
const DEAL_TO_CONTACT = 3
const DEAL_TO_COMPANY = 5

export interface ReplyTarget {
  firm: { id: string; name: string; status: string; hubspot_company_id: string | null; hubspot_deal_id: string | null }
  contact: { id: string; email: string | null; hubspot_contact_id: string | null } | null
  source: 'manual' | 'signup'
  sourceRef: string
}

export type ReplyPlan =
  | { ok: false; target: ReplyTarget; problem: string }
  | { ok: true; target: ReplyTarget; deal: 'create' | 'exists'; dealName: string }

export function dealName(firmName: string): string {
  return `${firmName} - Attorney Pilot`
}

/** Pure: what recording this reply would do. */
export function planReply(target: ReplyTarget): ReplyPlan {
  if (!target.firm.hubspot_company_id) {
    return { ok: false, target, problem: 'firm is not in HubSpot yet; run npm run hubspot:sync -- --send first' }
  }
  return { ok: true, target, deal: target.firm.hubspot_deal_id ? 'exists' : 'create', dealName: dealName(target.firm.name) }
}

const FIRM_COLUMNS = 'id, name, status, hubspot_company_id, hubspot_deal_id'

export async function targetFromEmail(db: Db, rawEmail: string): Promise<ReplyTarget> {
  const email = normalizeEmail(rawEmail)
  const { data: contact, error } = await db.from('contacts').select('id, email, hubspot_contact_id, firm_id').eq('email', email).maybeSingle()
  if (error) throw new Error(`load contact: ${error.message}`)
  if (!contact?.firm_id) throw new Error(`No pipeline contact with email ${email}`)
  const { data: firm, error: fErr } = await db.from('firms').select(FIRM_COLUMNS).eq('id', contact.firm_id).single()
  if (fErr) throw new Error(`load firm: ${fErr.message}`)
  return { firm, contact: { id: contact.id, email: contact.email, hubspot_contact_id: contact.hubspot_contact_id }, source: 'manual', sourceRef: email }
}

/** Signups matched to a pipeline firm whose firm hasn't been marked replied yet. */
export async function targetsFromSignups(db: Db): Promise<ReplyTarget[]> {
  const { data: signups, error } = await db
    .from('inbound_signups')
    .select('id, matched_firm_id, matched_contact_id')
    .not('matched_firm_id', 'is', null)
    .order('created_at')
  if (error) throw new Error(`load signups: ${error.message}`)
  const targets: ReplyTarget[] = []
  for (const s of signups) {
    const { data: firm, error: fErr } = await db.from('firms').select(FIRM_COLUMNS).eq('id', s.matched_firm_id!).single()
    if (fErr) throw new Error(`load firm: ${fErr.message}`)
    if (firm.status === 'replied') continue
    let contact: ReplyTarget['contact'] = null
    if (s.matched_contact_id) {
      const { data: c, error: cErr } = await db.from('contacts').select('id, email, hubspot_contact_id').eq('id', s.matched_contact_id).single()
      if (cErr) throw new Error(`load contact: ${cErr.message}`)
      contact = c
    }
    targets.push({ firm, contact, source: 'signup', sourceRef: s.id })
  }
  return targets
}

const DealSearchSchema = z.object({ results: z.array(z.object({ id: z.string() }).loose()) }).loose()
const DealSchema = z.object({ id: z.string() }).loose()

/**
 * Records the reply. Callers must hold HUBSPOT_SYNC_LOCK. Safe to repeat:
 * the event is idempotent per contact (or firm), and the deal is reused if
 * the firm already has one, or if one with the same name exists in the
 * pipeline (a run that created it but failed before storing the ID).
 */
export async function recordReply(db: Db, client: HubSpotClient, plan: Extract<ReplyPlan, { ok: true }>, options: { ownerId?: string } = {}): Promise<{ dealId: string; created: boolean }> {
  const { firm, contact } = plan.target
  let dealId = firm.hubspot_deal_id
  let created = false

  if (!dealId) {
    const pipeline = await resolveAttorneyPilot(client)
    const existing = await client.request('POST', '/crm/v3/objects/deals/search', DealSearchSchema, {
      body: {
        filterGroups: [{ filters: [
          { propertyName: 'dealname', operator: 'EQ', value: plan.dealName },
          { propertyName: 'pipeline', operator: 'EQ', value: pipeline.pipelineId },
        ] }],
        limit: 1,
      },
      idempotent: true,
    })
    dealId = existing.results[0]?.id ?? null

    if (!dealId) {
      const associations = [
        { to: { id: firm.hubspot_company_id! }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_COMPANY }] },
        ...(contact?.hubspot_contact_id
          ? [{ to: { id: contact.hubspot_contact_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: DEAL_TO_CONTACT }] }]
          : []),
      ]
      const deal = await client.request('POST', '/crm/v3/objects/deals', DealSchema, {
        body: {
          properties: {
            dealname: plan.dealName,
            pipeline: pipeline.pipelineId,
            dealstage: pipeline.stageIds.replied,
            ...(options.ownerId ? { hubspot_owner_id: options.ownerId } : {}),
          },
          associations,
        },
        // Not idempotent: only 429 is retried.
      })
      dealId = deal.id
      created = true
    }

    const { error } = await db.from('firms').update({ hubspot_deal_id: dealId }).eq('id', firm.id)
    if (error) throw new Error(`store deal id ${dealId} for firm ${firm.id}: ${error.message}`)
  }

  await appendEvent(db, {
    entity: contact ? 'contact' : 'firm',
    entityId: contact?.id ?? firm.id,
    type: 'contact_replied',
    payload: { firm_id: firm.id, source: plan.target.source, source_ref: plan.target.sourceRef, hubspot_deal_id: dealId, deal_created: created },
    idempotencyKey: `contact_replied:${contact?.id ?? `firm:${firm.id}`}`,
  })
  await setFirmStatus(db, firm.id, 'replied', { reason: `reply:${plan.target.source}` })
  return { dealId, created }
}
