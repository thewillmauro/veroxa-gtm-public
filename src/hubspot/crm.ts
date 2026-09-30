// Contact/company upserts and associations (SPEC §10).
//
// Contacts: batch upsert keyed by email (email is unique in HubSpot).
// Companies: HubSpot doesn't enforce unique domains, so upsert-by-domain
// could hit the wrong record. We search by domain, batch-update matches
// and batch-create the rest. If several companies share a domain, the
// oldest wins and the others come back in duplicateIds.
//
// Owner: HUBSPOT_OWNER_ID is set only on records this sync creates, so a
// manual reassignment in HubSpot is never overwritten. We can't call the
// owners API (no crm.objects.owners.read scope); the ID comes from config.

import { z } from 'zod'
import { normalizeDomain, normalizeEmail } from '../lib/email.js'
import { HubSpotBatchError, type HubSpotClient } from './client.js'

export const BATCH_SIZE = 100

export type Properties = Record<string, string>

export interface UpsertResult {
  /** HubSpot record ID. */
  id: string
  /** Normalized email or domain the caller passed. */
  key: string
  created: boolean
  /** Other companies with the same domain (companies only). */
  duplicateIds?: string[]
}

export interface UpsertOptions {
  ownerId?: string
}

const RecordSchema = z
  .object({
    id: z.string(),
    new: z.boolean().optional(),
    properties: z.record(z.string(), z.string().nullable()).default({}),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .loose()

export type HubSpotRecord = z.infer<typeof RecordSchema>

const BatchErrorSchema = z.object({ message: z.string(), category: z.string().optional() }).loose()

const BatchResponseSchema = z
  .object({
    results: z.array(RecordSchema).default([]),
    errors: z.array(BatchErrorSchema).default([]),
  })
  .loose()

const SearchResponseSchema = z
  .object({
    results: z.array(RecordSchema),
    paging: z.object({ next: z.object({ after: z.string() }).loose().optional() }).loose().optional(),
  })
  .loose()

type BatchResponse = z.infer<typeof BatchResponseSchema>

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function throwOnBatchErrors(res: BatchResponse): void {
  if (res.errors.length) {
    throw new HubSpotBatchError(
      res.errors.map((e) => ({ message: e.message, category: e.category })),
      res.results,
    )
  }
}

/** Dedupe by normalized key; later inputs' properties win. */
function dedupe<T extends { properties?: Properties }>(inputs: T[], keyOf: (i: T) => string): Map<string, Properties> {
  const byKey = new Map<string, Properties>()
  for (const input of inputs) {
    const key = keyOf(input)
    byKey.set(key, { ...byKey.get(key), ...input.properties })
  }
  return byKey
}

async function assignOwner(client: HubSpotClient, objectType: 'contacts', ids: string[], ownerId: string): Promise<void> {
  for (const ids100 of chunk(ids, BATCH_SIZE)) {
    const res = await client.request('POST', `/crm/v3/objects/${objectType}/batch/update`, BatchResponseSchema, {
      body: { inputs: ids100.map((id) => ({ id, properties: { hubspot_owner_id: ownerId } })) },
      idempotent: true,
    })
    throwOnBatchErrors(res)
  }
}

// ---------------------------------------------------------------- contacts

export interface FoundContact {
  id: string
  properties: Record<string, string | null>
}

/**
 * Look up existing contacts by primary email. Read-only: never creates.
 * Emails not in HubSpot are simply absent from the result.
 */
export async function findContactsByEmail(client: HubSpotClient, rawEmails: string[], properties: string[] = []): Promise<Map<string, FoundContact>> {
  const found = new Map<string, FoundContact>()
  const emails = [...new Set(rawEmails.map(normalizeEmail))]
  for (const batch of chunk(emails, BATCH_SIZE)) {
    let after: string | undefined
    do {
      const res = await client.request('POST', '/crm/v3/objects/contacts/search', SearchResponseSchema, {
        body: {
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: batch }] }],
          properties: [...new Set(['email', ...properties])],
          limit: 200,
          ...(after ? { after } : {}),
        },
        idempotent: true,
      })
      for (const r of res.results) {
        const email = r.properties['email']?.toLowerCase()
        if (email) found.set(email, { id: r.id, properties: r.properties })
      }
      after = res.paging?.next?.after
    } while (after)
  }
  return found
}

/** Batch-update existing contacts by HubSpot ID. Never creates. */
export async function updateContacts(client: HubSpotClient, updates: { id: string; properties: Properties }[]): Promise<void> {
  for (const batch of chunk(updates, BATCH_SIZE)) {
    const res = await client.request('POST', '/crm/v3/objects/contacts/batch/update', BatchResponseSchema, {
      body: { inputs: batch.map((u) => ({ id: u.id, properties: u.properties })) },
      idempotent: true,
    })
    throwOnBatchErrors(res)
  }
}

export interface ContactInput {
  email: string
  properties?: Properties
}

export async function upsertContacts(client: HubSpotClient, inputs: ContactInput[], options: UpsertOptions = {}): Promise<UpsertResult[]> {
  const byEmail = dedupe(inputs, (i) => normalizeEmail(i.email))
  const results: UpsertResult[] = []

  for (const emails of chunk([...byEmail.keys()], BATCH_SIZE)) {
    const res = await client.request('POST', '/crm/v3/objects/contacts/batch/upsert', BatchResponseSchema, {
      body: {
        inputs: emails.map((email) => ({ idProperty: 'email', id: email, properties: { ...byEmail.get(email), email } })),
      },
      // Keyed by email, so repeating it can't create a duplicate.
      idempotent: true,
    })
    throwOnBatchErrors(res)

    for (const r of res.results) {
      const email = r.properties['email']?.toLowerCase()
      if (!email || !byEmail.has(email)) throw new Error(`HubSpot upsert returned contact ${r.id} without a matching email`)
      results.push({ id: r.id, key: email, created: r.new === true })
    }
  }

  const createdIds = results.filter((r) => r.created).map((r) => r.id)
  if (options.ownerId && createdIds.length) await assignOwner(client, 'contacts', createdIds, options.ownerId)
  return results
}

export async function upsertContact(client: HubSpotClient, input: ContactInput, options: UpsertOptions = {}): Promise<UpsertResult> {
  const [result] = await upsertContacts(client, [input], options)
  if (!result) throw new Error(`HubSpot upsert returned no result for ${input.email}`)
  return result
}

// --------------------------------------------------------------- companies

export interface CompanyInput {
  domain: string
  properties?: Properties
}

/** Companies matching any of the domains, oldest first. */
export async function searchCompaniesByDomain(client: HubSpotClient, domains: string[]): Promise<Map<string, string[]>> {
  const idsByDomain = new Map<string, string[]>()
  let after: string | undefined
  do {
    const res = await client.request('POST', '/crm/v3/objects/companies/search', SearchResponseSchema, {
      body: {
        // IN needs lowercase values; normalizeDomain already lowercases.
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'IN', values: domains }] }],
        properties: ['domain'],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        limit: 200,
        ...(after ? { after } : {}),
      },
      idempotent: true,
    })
    for (const r of res.results) {
      const domain = r.properties['domain']?.toLowerCase()
      if (!domain) continue
      idsByDomain.set(domain, [...(idsByDomain.get(domain) ?? []), r.id])
    }
    after = res.paging?.next?.after
  } while (after)
  return idsByDomain
}

/**
 * Search indexing lags a few seconds behind writes, so a company created
 * moments ago by another process may not be found and would be created
 * twice. Callers must hold HUBSPOT_SYNC_LOCK (src/lib/job-lock.ts) so only
 * one sync runs at a time. The seconds-long lag inside a single run is an
 * accepted gap (2026-09-29).
 */
export async function upsertCompanies(client: HubSpotClient, inputs: CompanyInput[], options: UpsertOptions = {}): Promise<UpsertResult[]> {
  const byDomain = dedupe(inputs, (i) => {
    const d = normalizeDomain(i.domain)
    if (!d) throw new Error(`Invalid company domain: "${i.domain}"`)
    return d
  })
  const results: UpsertResult[] = []

  for (const domains of chunk([...byDomain.keys()], BATCH_SIZE)) {
    const existing = await searchCompaniesByDomain(client, domains)

    const toUpdate = domains.filter((d) => existing.has(d))
    const updates = toUpdate
      .map((domain) => ({ domain, id: existing.get(domain)![0]!, properties: byDomain.get(domain)! }))
      .filter((u) => Object.keys(u.properties).length > 0)
    if (updates.length) {
      const res = await client.request('POST', '/crm/v3/objects/companies/batch/update', BatchResponseSchema, {
        body: { inputs: updates.map((u) => ({ id: u.id, properties: u.properties })) },
        idempotent: true,
      })
      throwOnBatchErrors(res)
    }
    for (const domain of toUpdate) {
      const [id, ...others] = existing.get(domain)!
      results.push({ id: id!, key: domain, created: false, ...(others.length ? { duplicateIds: others } : {}) })
    }

    const toCreate = domains.filter((d) => !existing.has(d))
    if (toCreate.length) {
      const res = await client.request('POST', '/crm/v3/objects/companies/batch/create', BatchResponseSchema, {
        body: {
          inputs: toCreate.map((domain) => ({
            properties: { ...byDomain.get(domain), domain, ...(options.ownerId ? { hubspot_owner_id: options.ownerId } : {}) },
          })),
        },
        // Creates are not idempotent: only 429 is retried (see client.ts).
      })
      throwOnBatchErrors(res)
      for (const r of res.results) {
        const domain = r.properties['domain']?.toLowerCase()
        if (!domain || !byDomain.has(domain)) throw new Error(`HubSpot create returned company ${r.id} without a matching domain`)
        results.push({ id: r.id, key: domain, created: true })
      }
    }
  }
  return results
}

export async function upsertCompany(client: HubSpotClient, input: CompanyInput, options: UpsertOptions = {}): Promise<UpsertResult> {
  const [result] = await upsertCompanies(client, [input], options)
  if (!result) throw new Error(`HubSpot upsert returned no result for ${input.domain}`)
  return result
}

// ------------------------------------------------- generic batch primitives

export type CrmObject = 'contacts' | 'companies'

/** Batch create. Not idempotent: only 429 is retried (see client.ts). */
export async function createRecords(client: HubSpotClient, object: CrmObject, inputs: { properties: Properties }[]): Promise<HubSpotRecord[]> {
  const out: HubSpotRecord[] = []
  for (const batch of chunk(inputs, BATCH_SIZE)) {
    const res = await client.request('POST', `/crm/v3/objects/${object}/batch/create`, BatchResponseSchema, { body: { inputs: batch } })
    throwOnBatchErrors(res)
    out.push(...res.results)
  }
  return out
}

/** Batch update by HubSpot ID. Returns each record's updatedAt (HubSpot's clock). */
export async function updateRecords(client: HubSpotClient, object: CrmObject, updates: { id: string; properties: Properties }[]): Promise<HubSpotRecord[]> {
  const out: HubSpotRecord[] = []
  for (const batch of chunk(updates, BATCH_SIZE)) {
    const res = await client.request('POST', `/crm/v3/objects/${object}/batch/update`, BatchResponseSchema, {
      body: { inputs: batch.map((u) => ({ id: u.id, properties: u.properties })) },
      idempotent: true,
    })
    throwOnBatchErrors(res)
    out.push(...res.results)
  }
  return out
}

const HistoryEntrySchema = z
  .object({ value: z.string().nullable(), timestamp: z.string(), sourceType: z.string().optional(), sourceId: z.string().optional() })
  .loose()
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

const HistoryReadSchema = z
  .object({
    results: z
      .array(
        RecordSchema.extend({
          propertiesWithHistory: z.record(z.string(), z.array(HistoryEntrySchema)).default({}),
        }),
      )
      .default([]),
    errors: z.array(BatchErrorSchema).default([]),
  })
  .loose()

export interface RecordWithHistory {
  id: string
  properties: Record<string, string | null>
  /** Newest entry first, as HubSpot returns it. */
  history: Record<string, HistoryEntry[]>
}

/**
 * Current values plus property history, by ID. IDs HubSpot doesn't know
 * (e.g. archived) are simply absent from the result.
 */
export async function readWithHistory(client: HubSpotClient, object: CrmObject, ids: string[], properties: string[]): Promise<Map<string, RecordWithHistory>> {
  const found = new Map<string, RecordWithHistory>()
  for (const batch of chunk([...new Set(ids)], BATCH_SIZE)) {
    const res = await client.request('POST', `/crm/v3/objects/${object}/batch/read`, HistoryReadSchema, {
      body: { inputs: batch.map((id) => ({ id })), properties, propertiesWithHistory: properties },
      idempotent: true,
    })
    // Per-ID errors here are "not found", which we report as absent.
    for (const r of res.results) found.set(r.id, { id: r.id, properties: r.properties, history: r.propertiesWithHistory })
  }
  return found
}

// ------------------------------------------------------------ associations

const HubSpotIdSchema = z.string().regex(/^\d+$/, 'HubSpot IDs are numeric')

/** Link a contact to a company with HubSpot's default association type. Safe to repeat. */
export async function associateContactToCompany(client: HubSpotClient, contactId: string, companyId: string): Promise<void> {
  const from = HubSpotIdSchema.parse(contactId)
  const to = HubSpotIdSchema.parse(companyId)
  await client.request('PUT', `/crm/v4/objects/contact/${from}/associations/default/company/${to}`, z.unknown())
}
