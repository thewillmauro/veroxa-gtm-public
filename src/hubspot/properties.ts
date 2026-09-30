// Custom HubSpot properties.
//
// Contacts: the email opt-out mirror. Supabase `suppressions` is the source
// of truth (ADR 0003); these are a read-only copy for whoever works
// contacts in HubSpot.
// Companies: the SPEC §10 sync properties, written by the firm sync.
//
// Created by `npm run hubspot:setup`; if the key can't create properties,
// that script prints these definitions for the HubSpot UI.

import { z } from 'zod'
import { Constants } from '../lib/database.types.js'
import { HubSpotError, type HubSpotClient } from './client.js'

// Same values as the suppressions.reason check constraint, minus
// existing_customer (a do-not-pitch marker, not an opt-out; never mirrored).
export const OPT_OUT_REASONS = ['unsubscribed', 'bounced', 'complaint', 'manual'] as const
export type OptOutReason = (typeof OPT_OUT_REASONS)[number]

export type PropertyObject = 'contacts' | 'companies'

export interface PropertyDefinition {
  name: string
  label: string
  description: string
  groupName: string
  type: 'bool' | 'enumeration' | 'datetime' | 'number' | 'string'
  fieldType: 'booleancheckbox' | 'select' | 'date' | 'number' | 'text' | 'textarea'
  options?: { label: string; value: string; displayOrder: number }[]
}

// Built-in groups, so no group has to be created first.
const GROUP = 'contactinformation'
const COMPANY_GROUP = 'companyinformation'

export const CONTACT_PROPERTIES: PropertyDefinition[] = [
  {
    name: 'veroxa_email_opt_out',
    label: 'Veroxa email opt-out',
    description: 'Mirrored from Veroxa suppressions. Do not edit here; Supabase is the source of truth.',
    groupName: GROUP,
    type: 'bool',
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
  {
    name: 'veroxa_opt_out_reason',
    label: 'Veroxa opt-out reason',
    description: 'Why the contact is suppressed: unsubscribed, bounced, complaint, or manual.',
    groupName: GROUP,
    type: 'enumeration',
    fieldType: 'select',
    options: OPT_OUT_REASONS.map((value, displayOrder) => ({ label: value[0]!.toUpperCase() + value.slice(1), value, displayOrder })),
  },
  {
    name: 'veroxa_opt_out_at',
    label: 'Veroxa opt-out at',
    description: 'When the opt-out event happened.',
    groupName: GROUP,
    type: 'datetime',
    fieldType: 'date',
  },
]

const titleCase = (v: string): string => v.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ')

/** SPEC §10. Written by the firm sync (src/hubspot/sync-firms.ts). */
export const COMPANY_PROPERTIES: PropertyDefinition[] = [
  {
    name: 'veroxa_fit_score',
    label: 'Veroxa fit score',
    description: 'Fit score 0-100 from the Veroxa GTM scoring rules (SPEC §9). Synced from Supabase.',
    groupName: COMPANY_GROUP,
    type: 'number',
    fieldType: 'number',
  },
  {
    name: 'veroxa_score_breakdown',
    label: 'Veroxa score breakdown',
    description: 'Why the firm got its fit score, one rule per line. Synced from Supabase.',
    groupName: COMPANY_GROUP,
    type: 'string',
    fieldType: 'textarea',
  },
  {
    name: 'custody_evidence_url',
    label: 'Custody evidence URL',
    description: "Page on the firm's site showing it handles custody matters. Synced from Supabase.",
    groupName: COMPANY_GROUP,
    type: 'string',
    fieldType: 'text',
  },
  {
    name: 'pipeline_status',
    label: 'Veroxa pipeline status',
    description: 'Where the firm is in the Veroxa GTM pipeline. Synced from Supabase.',
    groupName: COMPANY_GROUP,
    type: 'enumeration',
    fieldType: 'select',
    // Straight from the DB enum, so the options can't drift from it.
    options: Constants.public.Enums.pipeline_status.map((value, displayOrder) => ({ label: titleCase(value), value, displayOrder })),
  },
  {
    name: 'lead_source',
    label: 'Lead source',
    description: 'Where the firm entered the Veroxa GTM pipeline (firms.source). Synced from Supabase.',
    groupName: COMPANY_GROUP,
    type: 'string',
    fieldType: 'text',
  },
]

export const PROPERTIES_BY_OBJECT: Record<PropertyObject, PropertyDefinition[]> = {
  contacts: CONTACT_PROPERTIES,
  companies: COMPANY_PROPERTIES,
}

const ExistingPropertySchema = z
  .object({
    name: z.string(),
    type: z.string(),
    fieldType: z.string(),
    options: z.array(z.object({ value: z.string() }).loose()).default([]),
  })
  .loose()

export type ExistingProperty = z.infer<typeof ExistingPropertySchema>

/** Ways an existing property differs from our definition. Empty = matches. */
export function propertyMismatches(want: PropertyDefinition, have: ExistingProperty): string[] {
  const out: string[] = []
  if (have.type !== want.type) out.push(`type is ${have.type}, want ${want.type}`)
  if (have.fieldType !== want.fieldType) out.push(`fieldType is ${have.fieldType}, want ${want.fieldType}`)
  if (want.type === 'enumeration') {
    const haveValues = new Set(have.options.map((o) => o.value))
    const missing = (want.options ?? []).filter((o) => !haveValues.has(o.value)).map((o) => o.value)
    if (missing.length) out.push(`missing options: ${missing.join(', ')}`)
  }
  return out
}

/** Step-by-step instructions for creating a property in the HubSpot UI. */
export function formatForUi(def: PropertyDefinition, object: PropertyObject = 'contacts'): string {
  const fieldLabel = {
    booleancheckbox: 'Single checkbox',
    select: 'Dropdown select',
    date: 'Date and time picker',
    number: 'Number',
    text: 'Single-line text',
    textarea: 'Multi-line text',
  }[def.fieldType]
  const lines = [
    `  Label:          ${def.label}`,
    `  Internal name:  ${def.name}   (click the </> icon next to the label to set it; it must match exactly)`,
    `  Object:         ${object === 'contacts' ? 'Contact' : 'Company'}`,
    `  Group:          ${object === 'contacts' ? 'Contact information' : 'Company information'}`,
    `  Description:    ${def.description}`,
    `  Field type:     ${fieldLabel}`,
  ]
  if (def.type === 'enumeration') {
    lines.push(`  Options (label -> internal value):`)
    for (const o of def.options ?? []) lines.push(`    ${o.label} -> ${o.value}`)
  }
  return lines.join('\n')
}

export type EnsureOutcome =
  | { name: string; status: 'exists' }
  | { name: string; status: 'mismatch'; problems: string[] }
  | { name: string; status: 'missing' } // dry run
  | { name: string; status: 'created' }
  | { name: string; status: 'refused'; error: HubSpotError }

/** Create each property only if it doesn't exist. Never modifies an existing one. */
export async function ensureProperties(
  client: HubSpotClient,
  object: PropertyObject,
  options: { apply: boolean },
  defs: PropertyDefinition[] = PROPERTIES_BY_OBJECT[object],
): Promise<EnsureOutcome[]> {
  const outcomes: EnsureOutcome[] = []
  for (const def of defs) {
    let have: ExistingProperty | undefined
    try {
      have = await client.request('GET', `/crm/v3/properties/${object}/${def.name}`, ExistingPropertySchema)
    } catch (err) {
      if (!(err instanceof HubSpotError && err.status === 404)) throw err
    }

    if (have) {
      const problems = propertyMismatches(def, have)
      outcomes.push(problems.length ? { name: def.name, status: 'mismatch', problems } : { name: def.name, status: 'exists' })
      continue
    }
    if (!options.apply) {
      outcomes.push({ name: def.name, status: 'missing' })
      continue
    }
    try {
      // Creating a property can't duplicate (names are unique; a repeat gets 409), so it's safe to retry.
      await client.request('POST', `/crm/v3/properties/${object}`, z.unknown(), { body: def, idempotent: true })
      outcomes.push({ name: def.name, status: 'created' })
    } catch (err) {
      if (err instanceof HubSpotError && err.status === 409) outcomes.push({ name: def.name, status: 'exists' })
      else if (err instanceof HubSpotError && (err.status === 403 || err.status === 401)) outcomes.push({ name: def.name, status: 'refused', error: err })
      else throw err
    }
  }
  return outcomes
}
