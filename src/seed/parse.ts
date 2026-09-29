// Pure CSV -> validated firm rows. No I/O, so every rule is unit-testable.
//
// Input columns (case-insensitive, any order): name, website, city, county,
// state. See data/seed/README.md and ADR 0006.

import { parse } from 'csv-parse/sync'
import { z } from 'zod'
import { normalizeDomain } from '../lib/email.js'
import { isActiveTarget, normalizeNjCounty, targetPhaseOf } from '../lib/targets.js'

export const REQUIRED_COLUMNS = ['name', 'website', 'state'] as const
export const OPTIONAL_COLUMNS = ['city', 'county'] as const
const KNOWN_COLUMNS = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS])

// Hosts where a firm's page is a path on a shared domain. Importing one would
// give the firm the directory's domain and collide with every other firm there.
export const SHARED_HOSTS = [
  'avvo.com', 'justia.com', 'findlaw.com', 'lawyers.com', 'martindale.com', 'superlawyers.com',
  'nolo.com', 'lawinfo.com', 'attorneys.com', 'legalmatch.com', 'expertise.com', 'thumbtack.com',
  'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com', 'yelp.com',
  'google.com', 'goo.gl', 'bbb.org', 'yellowpages.com', 'mapquest.com', 'linktr.ee',
]

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/

const STATE_NAMES: Record<string, string> = { 'new jersey': 'NJ', 'new york': 'NY' }

export interface FirmRow {
  rowNumber: number        // 1-based line in the file, header = 1
  name: string
  domain: string
  city: string | null
  county: string | null
  state: string
}

export interface RowIssue {
  rowNumber: number
  message: string
}

export interface ParseResult {
  rows: FirmRow[]
  errors: RowIssue[]       // rows rejected
  warnings: RowIssue[]     // rows imported, but worth a look
  duplicates: { rowNumber: number; domain: string; firstRowNumber: number }[]
  totalRows: number
}

function blank(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

export function isSharedHost(host: string): boolean {
  return SHARED_HOSTS.some((d) => host === d || host.endsWith('.' + d))
}

export function domainFromWebsite(website: string): { domain: string } | { error: string } {
  const domain = normalizeDomain(website)
  if (!HOST_RE.test(domain)) return { error: `website "${website}" is not a valid domain` }
  if (isSharedHost(domain)) {
    return { error: `website "${website}" is a directory or social profile (${domain}); use the firm's own site` }
  }
  return { domain }
}

export function normalizeState(raw: string): string | null {
  const t = raw.trim()
  const named = STATE_NAMES[t.toLowerCase()]
  if (named) return named
  return /^[a-z]{2}$/i.test(t) ? t.toUpperCase() : null
}

const RawRowSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(200, 'name is over 200 characters'),
  website: z.string().trim().min(1, 'website is required'),
  state: z.string().trim().min(1, 'state is required'),
  city: z.string().trim().max(100).nullable(),
  county: z.string().trim().max(100).nullable(),
})

export class CsvHeaderError extends Error {}

export function parseFirmsCsv(text: string): ParseResult {
  let records: string[][]
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: false })
  } catch (e) {
    throw new CsvHeaderError(`Could not parse CSV: ${(e as Error).message}`)
  }

  const [header, ...body] = records
  if (!header) throw new CsvHeaderError('CSV is empty')

  const columns = header.map((h) => h.trim().toLowerCase())
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c))
  if (missing.length) throw new CsvHeaderError(`CSV is missing required column(s): ${missing.join(', ')}`)
  const dupCols = columns.filter((c, i) => c && columns.indexOf(c) !== i)
  if (dupCols.length) throw new CsvHeaderError(`CSV has duplicate column(s): ${[...new Set(dupCols)].join(', ')}`)

  const result: ParseResult = { rows: [], errors: [], warnings: [], duplicates: [], totalRows: 0 }
  const unknown = columns.filter((c) => c && !KNOWN_COLUMNS.has(c))
  if (unknown.length) result.warnings.push({ rowNumber: 1, message: `ignoring unknown column(s): ${unknown.join(', ')}` })

  const firstRowByDomain = new Map<string, number>()

  body.forEach((record, i) => {
    const rowNumber = i + 2
    if (record.every((cell) => cell.trim() === '')) return
    result.totalRows++

    const get = (col: string) => {
      const idx = columns.indexOf(col)
      return idx === -1 ? undefined : record[idx]
    }
    const raw = RawRowSchema.safeParse({
      name: get('name') ?? '',
      website: get('website') ?? '',
      state: get('state') ?? '',
      city: blank(get('city')),
      county: blank(get('county')),
    })
    if (!raw.success) {
      result.errors.push({ rowNumber, message: raw.error.issues.map((iss) => iss.message).join('; ') })
      return
    }

    const problems: string[] = []
    const d = domainFromWebsite(raw.data.website)
    if ('error' in d) problems.push(d.error)

    const state = normalizeState(raw.data.state)
    if (!state) problems.push(`state "${raw.data.state}" must be a 2-letter code`)

    let county: string | null = raw.data.county
    if (county && state === 'NJ') {
      const nj = normalizeNjCounty(county)
      if (nj) county = nj
      else problems.push(`county "${raw.data.county}" is not a New Jersey county`)
    } else if (county) {
      county = county.replace(/\s+county$/i, '').trim()
    }

    if (problems.length || 'error' in d || !state) {
      result.errors.push({ rowNumber, message: problems.join('; ') })
      return
    }

    const first = firstRowByDomain.get(d.domain)
    if (first !== undefined) {
      result.duplicates.push({ rowNumber, domain: d.domain, firstRowNumber: first })
      return
    }
    firstRowByDomain.set(d.domain, rowNumber)

    if (!county) {
      result.warnings.push({ rowNumber, message: 'no county; firm will not earn target-county points' })
    } else if (!isActiveTarget(state, county)) {
      const phase = targetPhaseOf(state, county)
      result.warnings.push({
        rowNumber,
        message: phase ? `${county}, ${state} is a ${phase} county, not scored yet` : `${county}, ${state} is outside the target counties`,
      })
    }

    result.rows.push({ rowNumber, name: raw.data.name, domain: d.domain, city: raw.data.city, county, state })
  })

  return result
}
