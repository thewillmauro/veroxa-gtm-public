// Import validated firm rows into Supabase. Dry run reads only.
//
// Dedupe happens twice: in-file by parseFirmsCsv, then against the DB here.
// The DB check is advisory (for the report); the insert itself uses
// ON CONFLICT DO NOTHING inside import_firms(), so a concurrent import can't
// create duplicates or overwrite an existing firm.

import type { Db } from '../lib/db.js'
import type { FirmRow } from './parse.js'

export const SOURCE_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/
export const DEFAULT_SOURCE = 'manual_csv'
const CHUNK = 500

export interface ImportPlan {
  toInsert: FirmRow[]
  existing: FirmRow[]
}

export interface ImportOutcome {
  inserted: { id: string; domain: string; rowNumber: number }[]
  skippedExisting: FirmRow[]
}

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

export async function findExistingDomains(db: Db, domains: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (const batch of chunks(domains, CHUNK)) {
    const { data, error } = await db.from('firms').select('domain').in('domain', batch)
    if (error) throw new Error(`Checking existing firms failed: ${error.message}`)
    for (const r of data) if (r.domain) found.add(r.domain)
  }
  return found
}

export async function planImport(db: Db, rows: FirmRow[]): Promise<ImportPlan> {
  const existing = await findExistingDomains(db, rows.map((r) => r.domain))
  return {
    toInsert: rows.filter((r) => !existing.has(r.domain)),
    existing: rows.filter((r) => existing.has(r.domain)),
  }
}

export async function importFirms(
  db: Db,
  rows: FirmRow[],
  opts: { source: string; importId: string },
): Promise<ImportOutcome> {
  if (!SOURCE_RE.test(opts.source)) throw new Error(`Invalid source "${opts.source}"`)

  const byDomain = new Map(rows.map((r) => [r.domain, r]))
  const inserted: ImportOutcome['inserted'] = []

  for (const batch of chunks(rows, CHUNK)) {
    const payload = batch.map((r) => ({
      name: r.name,
      domain: r.domain,
      city: r.city,
      county: r.county,
      state: r.state,
      row_number: r.rowNumber,
    }))
    const { data, error } = await db.rpc('import_firms', {
      p_firms: payload,
      p_source: opts.source,
      p_import_id: opts.importId,
    })
    if (error) throw new Error(`import_firms failed: ${error.message}`)
    for (const r of data ?? []) {
      inserted.push({ id: r.id, domain: r.domain, rowNumber: byDomain.get(r.domain)?.rowNumber ?? -1 })
    }
  }

  const insertedDomains = new Set(inserted.map((r) => r.domain))
  return { inserted, skippedExisting: rows.filter((r) => !insertedDomains.has(r.domain)) }
}
