// Firm and contact sync to HubSpot (SPEC §10, ADR 0010).
//
// Companies:
//   - Found by stored hubspot_company_id, else by domain search, else created.
//     HubSpot doesn't enforce unique domains, so we always search first.
//   - Standard fields (name, domain, city, state, employees, owner) are set
//     on create only. Existing records only get the Veroxa properties.
//   - Veroxa properties (SPEC §10) are written only if they changed, and
//     never over a manual edit: if a property's newest history entry wasn't
//     written by this integration, it's a conflict and we leave it alone
//     (reported, and logged as an event). last_synced_at stores HubSpot's own
//     updatedAt from our last write, which is how we recognize our entries.
// Contacts:
//   - Only decision-makers with a verified email that isn't suppressed, held,
//     or unsubscribed. Everyone else is skipped with a reason.
//   - Found by email, else created with standard fields. No Veroxa contact
//     properties are written here (the opt-out mirror owns those).
//   - Associated to their firm's company (idempotent).
//
// Callers must hold HUBSPOT_SYNC_LOCK when sending (search-then-create).

import { z } from 'zod'
import type { Db, PipelineStatus } from '../lib/db.js'
import type { Json } from '../lib/database.types.js'
import { appendEvent, setFirmStatus } from '../lib/events.js'
import type { Logger } from '../lib/logger.js'
import { waterfallName } from '../clay/send-dm.js'
import type { HubSpotClient } from './client.js'
import { HubSpotBatchError } from './client.js'
import {
  associateContactToCompany,
  createRecords,
  findContactsByEmail,
  readWithHistory,
  searchCompaniesByDomain,
  updateRecords,
  type HistoryEntry,
  type HubSpotRecord,
  type Properties,
  type RecordWithHistory,
} from './crm.js'
import { COMPANY_PROPERTIES } from './properties.js'

/** Firms that have been researched. new / sent_to_clay / enriched and disqualified are never synced. */
export const SYNCABLE_STATUSES: readonly PipelineStatus[] = ['researched', 'scored', 'qualified', 'synced', 'drafted', 'contacted', 'replied']

export const VEROXA_COMPANY_PROPS = COMPANY_PROPERTIES.map((p) => p.name)

export interface FirmRow {
  id: string
  name: string
  domain: string | null
  city: string | null
  state: string | null
  source: string
  status: PipelineStatus
  headcount_est: number | null
  fit_score: number | null
  score_breakdown: Json | null
  custody_evidence_url: string | null
  hubspot_company_id: string | null
  last_synced_at: string | null
}

export interface ContactRow {
  id: string
  firm_id: string | null
  full_name: string | null
  title: string | null
  email: string | null
  email_verified: boolean | null
  is_decision_maker: boolean | null
  unsubscribed: boolean | null
  hubspot_contact_id: string | null
}

export interface SuppressionRow {
  email: string
  reason: string
  source: string
}

// ------------------------------------------------------------ pure rules

/** Syncing moves a qualified firm to synced; later or other stages keep their status. */
export function statusAfterSync(status: PipelineStatus): PipelineStatus {
  return status === 'qualified' ? 'synced' : status
}

const BreakdownSchema = z
  .object({
    version: z.string().optional(),
    lines: z.array(z.object({ rule: z.string(), points: z.number(), max: z.number(), basis: z.string() }).loose()),
  })
  .loose()

/** Human-readable score breakdown for the HubSpot textarea, one rule per line. */
export function formatBreakdown(fitScore: number | null, breakdown: Json | null): string | undefined {
  if (breakdown === null) return undefined
  const parsed = BreakdownSchema.safeParse(breakdown)
  if (!parsed.success) return JSON.stringify(breakdown)
  const header = `Total ${fitScore ?? '?'}/100${parsed.data.version ? ` (scoring ${parsed.data.version})` : ''}`
  return [header, ...parsed.data.lines.map((l) => `${l.rule}: ${l.points}/${l.max} (${l.basis})`)].join('\n')
}

function compact(props: Record<string, string | undefined | null>): Properties {
  return Object.fromEntries(Object.entries(props).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
}

/** SPEC §10 properties, as they should be after this sync. */
export function companyVeroxaProps(firm: FirmRow): Properties {
  return compact({
    veroxa_fit_score: firm.fit_score === null ? undefined : String(firm.fit_score),
    veroxa_score_breakdown: formatBreakdown(firm.fit_score, firm.score_breakdown),
    custody_evidence_url: firm.custody_evidence_url,
    pipeline_status: statusAfterSync(firm.status),
    lead_source: firm.source,
  })
}

/** Standard fields, sent on create only. */
export function companyCreateOnlyProps(firm: FirmRow, ownerId?: string): Properties {
  return compact({
    name: firm.name,
    domain: firm.domain,
    city: firm.city,
    state: firm.state,
    numberofemployees: firm.headcount_est === null ? undefined : String(firm.headcount_est),
    hubspot_owner_id: ownerId,
  })
}

const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i

/**
 * HubSpot has no middle-name field: the last word is the last name (with a
 * generational suffix kept on it), everything before is the first name.
 * "Dana R. Whitlock, Esq." -> Dana R. / Whitlock; "Robert T. Hale Jr." -> Robert T. / Hale Jr.
 */
export function splitName(fullName: string | null): { firstname?: string; lastname?: string } {
  const words = (fullName ? waterfallName(fullName) : '').replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return {}
  if (words.length === 1) return { firstname: words[0]! }
  const lastLen = words.length > 2 && SUFFIX.test(words[words.length - 1]!) ? 2 : 1
  return { firstname: words.slice(0, -lastLen).join(' '), lastname: words.slice(-lastLen).join(' ') }
}

export function contactCreateProps(contact: ContactRow, firm: FirmRow, ownerId?: string): Properties {
  return compact({
    email: contact.email,
    ...splitName(contact.full_name),
    jobtitle: contact.title,
    company: firm.name,
    hubspot_owner_id: ownerId,
  })
}

export type SkipReason = 'no_email' | 'held' | 'suppressed' | 'unsubscribed' | 'not_decision_maker' | 'unverified'

export type Eligibility = { ok: true } | { ok: false; reason: SkipReason; detail?: string }

/** Order matters: the most important reason is reported. */
export function contactEligibility(contact: ContactRow, suppression: SuppressionRow | undefined): Eligibility {
  if (!contact.email) return { ok: false, reason: 'no_email' }
  if (suppression?.source.startsWith('hold:')) return { ok: false, reason: 'held', detail: suppression.source }
  if (suppression) return { ok: false, reason: 'suppressed', detail: `${suppression.reason} (${suppression.source})` }
  if (contact.unsubscribed) return { ok: false, reason: 'unsubscribed' }
  if (!contact.is_decision_maker) return { ok: false, reason: 'not_decision_maker' }
  if (!contact.email_verified) return { ok: false, reason: 'unverified' }
  return { ok: true }
}

export interface Conflict {
  property: string
  hubspotValue: string | null
  wanted: string
  editedBy: string
  editedAt: string
}

export interface CompanyWrites {
  write: Properties
  unchanged: string[]
  conflicts: Conflict[]
}

export function isOurEntry(entry: HistoryEntry, ourSourceIds: ReadonlySet<string>): boolean {
  if (entry.sourceType !== 'INTEGRATION') return false
  // Before we know our own source ID, any integration write counts as ours.
  return ourSourceIds.size === 0 || ourSourceIds.has(entry.sourceId ?? '')
}

/**
 * Which Veroxa properties to write on an existing company. A property whose
 * newest history entry came from someone other than this integration was
 * edited in HubSpot: it's a conflict and is left alone, on this run and
 * every later one, until someone reverts it or clears the conflict.
 */
export function decideCompanyWrites(desired: Properties, current: RecordWithHistory | undefined, ourSourceIds: ReadonlySet<string>): CompanyWrites {
  const result: CompanyWrites = { write: {}, unchanged: [], conflicts: [] }
  for (const [prop, wanted] of Object.entries(desired)) {
    const have = current?.properties[prop] ?? null
    const newest = current?.history[prop]?.[0]
    if (newest && newest.value !== null && newest.value !== '' && !isOurEntry(newest, ourSourceIds)) {
      if ((have ?? '').trim() !== wanted.trim()) {
        result.conflicts.push({ property: prop, hubspotValue: have, wanted, editedBy: newest.sourceType ?? 'unknown', editedAt: newest.timestamp })
      } else {
        result.unchanged.push(prop)
      }
      continue
    }
    if ((have ?? '').trim() === wanted.trim()) result.unchanged.push(prop)
    else result.write[prop] = wanted
  }
  return result
}

/** Our integration's HubSpot sourceId(s): the history entries stamped exactly at a firm's last_synced_at. */
export function learnOurSourceIds(records: Iterable<RecordWithHistory>, lastSyncedById: ReadonlyMap<string, string | null>): Set<string> {
  const ids = new Set<string>()
  for (const r of records) {
    const at = lastSyncedById.get(r.id)
    if (!at) continue
    const t = Date.parse(at)
    for (const entries of Object.values(r.history)) {
      for (const e of entries) {
        if (e.sourceType === 'INTEGRATION' && e.sourceId && Date.parse(e.timestamp) === t) ids.add(e.sourceId)
      }
    }
  }
  return ids
}

// ------------------------------------------------------------------- load

export interface SyncInput {
  firms: FirmRow[]
  contacts: ContactRow[]
  suppressions: Map<string, SuppressionRow>
}

export async function loadSyncInput(db: Db): Promise<SyncInput> {
  const { data: firms, error } = await db
    .from('firms')
    .select('id, name, domain, city, state, source, status, headcount_est, fit_score, score_breakdown, custody_evidence_url, hubspot_company_id, last_synced_at')
    .in('status', [...SYNCABLE_STATUSES])
    .order('name')
  if (error) throw new Error(`load firms: ${error.message}`)
  if (!firms.length) return { firms: [], contacts: [], suppressions: new Map() }

  const { data: contacts, error: cErr } = await db
    .from('contacts')
    .select('id, firm_id, full_name, title, email, email_verified, is_decision_maker, unsubscribed, hubspot_contact_id')
    .in('firm_id', firms.map((f) => f.id))
    .order('email')
  if (cErr) throw new Error(`load contacts: ${cErr.message}`)

  const emails = contacts.map((c) => c.email).filter((e): e is string => !!e)
  const { data: sups, error: sErr } = emails.length
    ? await db.from('suppressions').select('email, reason, source').in('email', emails)
    : { data: [] as SuppressionRow[], error: null }
  if (sErr) throw new Error(`load suppressions: ${sErr.message}`)

  return { firms, contacts, suppressions: new Map(sups.map((s) => [s.email, s])) }
}

// ------------------------------------------------------------------- plan

export type CompanyAction =
  | { kind: 'create'; firm: FirmRow; properties: Properties }
  | { kind: 'update'; firm: FirmRow; hubspotId: string; how: 'stored_id' | 'domain_match'; writes: CompanyWrites; duplicateIds: string[] }

export type ContactAction =
  | { kind: 'create'; contact: ContactRow; firm: FirmRow; properties: Properties }
  | { kind: 'link'; contact: ContactRow; firm: FirmRow; hubspotId: string }

export interface SkippedContact {
  contact: ContactRow
  firm: FirmRow
  reason: SkipReason
  detail?: string
}

export interface SyncPlan {
  companies: CompanyAction[]
  contacts: ContactAction[]
  skipped: SkippedContact[]
  firmsWithoutDomain: FirmRow[]
  staleIds: { firm: FirmRow; storedId: string }[]
}

/** Reads HubSpot (search + batch read) and decides every write. Writes nothing. */
export async function planSync(client: HubSpotClient, input: SyncInput, options: { ownerId?: string } = {}): Promise<SyncPlan> {
  const plan: SyncPlan = { companies: [], contacts: [], skipped: [], firmsWithoutDomain: [], staleIds: [] }
  const firms = input.firms.filter((f) => {
    if (f.domain) return true
    plan.firmsWithoutDomain.push(f)
    return false
  })

  // Resolve each firm to a HubSpot company: stored ID first, then domain.
  const stored = firms.filter((f) => f.hubspot_company_id)
  const storedRecords = await readWithHistory(client, 'companies', stored.map((f) => f.hubspot_company_id!), VEROXA_COMPANY_PROPS)
  const resolved = new Map<string, { id: string; how: 'stored_id' | 'domain_match'; duplicateIds: string[] }>()
  for (const f of stored) {
    if (storedRecords.has(f.hubspot_company_id!)) resolved.set(f.id, { id: f.hubspot_company_id!, how: 'stored_id', duplicateIds: [] })
    else plan.staleIds.push({ firm: f, storedId: f.hubspot_company_id! })
  }

  const unresolved = firms.filter((f) => !resolved.has(f.id))
  const byDomain = unresolved.length ? await searchCompaniesByDomain(client, unresolved.map((f) => f.domain!)) : new Map<string, string[]>()
  for (const f of unresolved) {
    const [id, ...dupes] = byDomain.get(f.domain!) ?? []
    if (id) resolved.set(f.id, { id, how: 'domain_match', duplicateIds: dupes })
  }

  const domainIds = [...resolved.values()].filter((r) => r.how === 'domain_match').map((r) => r.id)
  const domainRecords = domainIds.length ? await readWithHistory(client, 'companies', domainIds, VEROXA_COMPANY_PROPS) : new Map<string, RecordWithHistory>()
  const records = new Map([...storedRecords, ...domainRecords])

  const lastSyncedByCompany = new Map<string, string | null>()
  for (const f of firms) {
    const r = resolved.get(f.id)
    if (r) lastSyncedByCompany.set(r.id, f.last_synced_at)
  }
  const ourSourceIds = learnOurSourceIds(records.values(), lastSyncedByCompany)

  for (const f of firms) {
    const r = resolved.get(f.id)
    const desired = companyVeroxaProps(f)
    if (!r) {
      plan.companies.push({ kind: 'create', firm: f, properties: { ...companyCreateOnlyProps(f, options.ownerId), ...desired } })
      continue
    }
    plan.companies.push({ kind: 'update', firm: f, hubspotId: r.id, how: r.how, writes: decideCompanyWrites(desired, records.get(r.id), ourSourceIds), duplicateIds: r.duplicateIds })
  }

  // Contacts: eligibility, then find by email.
  const firmById = new Map(firms.map((f) => [f.id, f]))
  const eligible: { contact: ContactRow; firm: FirmRow }[] = []
  for (const c of input.contacts) {
    const firm = c.firm_id ? firmById.get(c.firm_id) : undefined
    if (!firm) continue
    const e = contactEligibility(c, c.email ? input.suppressions.get(c.email) : undefined)
    if (e.ok) eligible.push({ contact: c, firm })
    else plan.skipped.push({ contact: c, firm, reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) })
  }
  const found = eligible.length ? await findContactsByEmail(client, eligible.map((e) => e.contact.email!)) : new Map()
  for (const { contact, firm } of eligible) {
    const hit = found.get(contact.email!.toLowerCase())
    if (hit) plan.contacts.push({ kind: 'link', contact, firm, hubspotId: hit.id })
    else plan.contacts.push({ kind: 'create', contact, firm, properties: contactCreateProps(contact, firm, options.ownerId) })
  }
  return plan
}

// ---------------------------------------------------------------- execute

export interface SyncSummary {
  companiesCreated: number
  companiesUpdated: number
  companiesUnchanged: number
  conflicts: { firm: string; conflicts: Conflict[] }[]
  contactsCreated: number
  contactsLinked: number
  skippedLogged: number
  statusChanged: number
}

async function storeFirm(db: Db, firmId: string, patch: { hubspot_company_id: string; last_synced_at: string }): Promise<void> {
  const { error } = await db.from('firms').update(patch).eq('id', firmId)
  if (error) throw new Error(`store HubSpot company id for firm ${firmId}: ${error.message}`)
}

async function storeContact(db: Db, contactId: string, patch: { hubspot_contact_id: string; last_synced_at: string }): Promise<void> {
  const { error } = await db.from('contacts').update(patch).eq('id', contactId)
  if (error) throw new Error(`store HubSpot contact id for contact ${contactId}: ${error.message}`)
}

/** Creates and returns records; on a partial batch failure, still hands back what was created. */
async function createKeepingPartial(
  client: HubSpotClient,
  object: 'contacts' | 'companies',
  inputs: { properties: Properties }[],
  onCreated: (records: HubSpotRecord[]) => Promise<void>,
): Promise<void> {
  try {
    await onCreated(await createRecords(client, object, inputs))
  } catch (err) {
    if (err instanceof HubSpotBatchError) {
      const partial = z.array(z.object({ id: z.string(), properties: z.record(z.string(), z.string().nullable()) }).loose()).safeParse(err.partialResults)
      if (partial.success && partial.data.length) await onCreated(partial.data as HubSpotRecord[])
    }
    throw err
  }
}

export async function executeSync(db: Db, client: HubSpotClient, plan: SyncPlan, log: Logger): Promise<SyncSummary> {
  const summary: SyncSummary = { companiesCreated: 0, companiesUpdated: 0, companiesUnchanged: 0, conflicts: [], contactsCreated: 0, contactsLinked: 0, skippedLogged: 0, statusChanged: 0 }
  const companyIdByFirm = new Map<string, string>()
  const nowIso = () => new Date().toISOString()

  // Companies: creates.
  const creates = plan.companies.filter((a): a is Extract<CompanyAction, { kind: 'create' }> => a.kind === 'create')
  if (creates.length) {
    const firmByDomain = new Map(creates.map((a) => [a.firm.domain!, a.firm]))
    await createKeepingPartial(client, 'companies', creates.map((a) => ({ properties: a.properties })), async (records) => {
      for (const r of records) {
        const firm = firmByDomain.get((r.properties['domain'] ?? '').toLowerCase())
        if (!firm) throw new Error(`HubSpot created company ${r.id} for an unexpected domain ${r.properties['domain']}`)
        await storeFirm(db, firm.id, { hubspot_company_id: r.id, last_synced_at: r.updatedAt ?? r.createdAt ?? nowIso() })
        companyIdByFirm.set(firm.id, r.id)
        summary.companiesCreated++
        await appendEvent(db, { entity: 'firm', entityId: firm.id, type: 'hubspot_company_synced', payload: { action: 'created', hubspot_company_id: r.id } })
      }
    })
  }

  // Companies: updates (only changed, non-conflicting Veroxa properties).
  const updates = plan.companies.filter((a): a is Extract<CompanyAction, { kind: 'update' }> => a.kind === 'update')
  const toWrite = updates.filter((a) => Object.keys(a.writes.write).length)
  const updatedAt = new Map<string, string>()
  if (toWrite.length) {
    for (const r of await updateRecords(client, 'companies', toWrite.map((a) => ({ id: a.hubspotId, properties: a.writes.write })))) {
      if (r.updatedAt) updatedAt.set(r.id, r.updatedAt)
    }
  }
  for (const a of updates) {
    const wrote = Object.keys(a.writes.write)
    // Keep last_synced_at pointing at our own last write; if nothing was written, keep the old one.
    const lastSynced = updatedAt.get(a.hubspotId) ?? a.firm.last_synced_at ?? nowIso()
    await storeFirm(db, a.firm.id, { hubspot_company_id: a.hubspotId, last_synced_at: lastSynced })
    companyIdByFirm.set(a.firm.id, a.hubspotId)
    if (wrote.length) summary.companiesUpdated++
    else summary.companiesUnchanged++
    if (a.writes.conflicts.length) {
      summary.conflicts.push({ firm: a.firm.name, conflicts: a.writes.conflicts })
      log.warn('hubspot conflict: property edited in HubSpot, left unchanged', { firmId: a.firm.id, properties: a.writes.conflicts.map((c) => c.property) })
    }
    await appendEvent(db, {
      entity: 'firm',
      entityId: a.firm.id,
      type: 'hubspot_company_synced',
      payload: {
        action: wrote.length ? 'updated' : 'unchanged',
        how: a.how,
        hubspot_company_id: a.hubspotId,
        written: wrote,
        conflicts: a.writes.conflicts as unknown as Json,
        duplicate_ids: a.duplicateIds,
      },
    })
  }

  // Firm status: qualified -> synced (after the company exists in HubSpot).
  for (const a of plan.companies) {
    const to = statusAfterSync(a.firm.status)
    if (to !== a.firm.status && companyIdByFirm.has(a.firm.id)) {
      await setFirmStatus(db, a.firm.id, to, { reason: 'hubspot_synced' })
      summary.statusChanged++
    }
  }

  // Contacts: creates, then links; associate every synced contact with its company.
  const contactIds = new Map<string, string>()
  const contactCreates = plan.contacts.filter((a): a is Extract<ContactAction, { kind: 'create' }> => a.kind === 'create')
  if (contactCreates.length) {
    const byEmail = new Map(contactCreates.map((a) => [a.contact.email!.toLowerCase(), a.contact]))
    await createKeepingPartial(client, 'contacts', contactCreates.map((a) => ({ properties: a.properties })), async (records) => {
      for (const r of records) {
        const contact = byEmail.get((r.properties['email'] ?? '').toLowerCase())
        if (!contact) throw new Error(`HubSpot created contact ${r.id} for an unexpected email`)
        await storeContact(db, contact.id, { hubspot_contact_id: r.id, last_synced_at: r.updatedAt ?? r.createdAt ?? nowIso() })
        contactIds.set(contact.id, r.id)
        summary.contactsCreated++
        await appendEvent(db, { entity: 'contact', entityId: contact.id, type: 'hubspot_contact_synced', payload: { action: 'created', hubspot_contact_id: r.id } })
      }
    })
  }
  for (const a of plan.contacts) {
    if (a.kind !== 'link') continue
    await storeContact(db, a.contact.id, { hubspot_contact_id: a.hubspotId, last_synced_at: nowIso() })
    contactIds.set(a.contact.id, a.hubspotId)
    summary.contactsLinked++
    await appendEvent(db, { entity: 'contact', entityId: a.contact.id, type: 'hubspot_contact_synced', payload: { action: 'linked', hubspot_contact_id: a.hubspotId } })
  }
  for (const a of plan.contacts) {
    const contactId = contactIds.get(a.contact.id)
    const companyId = companyIdByFirm.get(a.firm.id)
    if (contactId && companyId) await associateContactToCompany(client, contactId, companyId)
  }

  // Skipped contacts: one event per contact and reason, ever.
  for (const s of plan.skipped) {
    const res = await appendEvent(db, {
      entity: 'contact',
      entityId: s.contact.id,
      type: 'hubspot_skipped',
      payload: { reason: s.reason, detail: s.detail ?? null },
      idempotencyKey: `hubspot_skipped:${s.contact.id}:${s.reason}`,
    })
    if (res.inserted) summary.skippedLogged++
  }
  return summary
}
