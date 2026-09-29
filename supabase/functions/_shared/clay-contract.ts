// Clay contract (SPEC §7). Shared by the Node send script and the Deno
// clay-callback function, so both sides validate against one definition.
//
// Outbound (us -> Clay) is strict: we build it. Inbound (Clay -> us) is
// lenient at the edge and strict after: Clay's HTTP API column often sends
// numbers and booleans as strings, blanks as "", and lists as JSON strings.
// Everything is normalized here before it reaches the database. See ADR 0008.

import { z } from 'zod'

/** Which callback secret Clay is configured with. Bump on rotation (ADR 0008). */
export const CLAY_CALLBACK_SECRET_REF = 'v1'
export const CLAY_CALLBACK_SECRET_HEADER = 'x-veroxa-secret'
export const MAX_CALLBACK_BYTES = 256 * 1024
export const MAX_PEOPLE_PER_CALLBACK = 50

// ---------------------------------------------------------------------------
// Outbound: Supabase -> Clay webhook table
// ---------------------------------------------------------------------------

export const ClayOutboundSchema = z.strictObject({
  firm_id: z.uuid(),
  name: z.string().min(1),
  domain: z.string().min(1),
  city: z.string().nullable(),
  state: z.string().nullable(),
  callback_secret_ref: z.string().min(1),
})

export type ClayOutbound = z.infer<typeof ClayOutboundSchema>

export function buildOutboundPayload(firm: {
  id: string
  name: string
  domain: string | null
  city: string | null
  state: string | null
}): ClayOutbound {
  if (!firm.domain) throw new Error(`Firm ${firm.id} has no domain; Clay enrichment keys on domain`)
  return ClayOutboundSchema.parse({
    firm_id: firm.id,
    name: firm.name,
    domain: firm.domain,
    city: firm.city,
    state: firm.state,
    callback_secret_ref: CLAY_CALLBACK_SECRET_REF,
  })
}

// Outbound: verified decision-makers -> GTM Decision Makers table (M4)
export const ClayDmOutboundSchema = z.strictObject({
  firm_id: z.uuid(),
  firm_name: z.string().min(1), // Company Name input for the email waterfall
  domain: z.string().min(1),
  dm_name: z.string().min(1),
  dm_title: z.string().min(1),
  evidence_url: z.url(),
})

export type ClayDmOutbound = z.infer<typeof ClayDmOutboundSchema>

// ---------------------------------------------------------------------------
// Inbound: Clay -> clay-callback
// ---------------------------------------------------------------------------

const looseText = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    return s === '' || s.toLowerCase() === 'null' ? null : s
  })

export type FirmSizeBand = 'solo' | 'small' | 'mid' | 'large'

export interface Headcount {
  lower: number
  upper: number | null // null for an exact count's open end, e.g. "10,001+"
  exact: boolean
}

// One count: "6", "1204", "1,204". Comma grouping must be real thousands groups.
const COUNT_RE = /^(?:\d{1,3}(?:,\d{3})+|\d+)$/
const MAX_HEADCOUNT = 10_000_000

function parseCount(s: string): number | null {
  if (!COUNT_RE.test(s)) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isSafeInteger(n) && n <= MAX_HEADCOUNT ? n : null
}

/**
 * Accepts an exact count or a size range as enrichment providers report it:
 * 6, "6", "1,204", "11-50", "51 - 200", "11–50", "1,001-5,000", "10,001+",
 * with an optional trailing "employees". Returns null for "malformed".
 */
export function parseHeadcount(v: number | string): Headcount | null {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v >= 0 && v <= MAX_HEADCOUNT ? { lower: v, upper: v, exact: true } : null
  }
  const s = v
    .trim()
    .toLowerCase()
    .replace(/\s*employees?$/, '')
    .replace(/[\u2012-\u2015]/g, '-') // en/em dashes from copy-paste
    .replace(/\s+/g, '')

  const exact = parseCount(s)
  if (exact !== null) return { lower: exact, upper: exact, exact: true }

  const open = /^([\d,]+)\+$/.exec(s)
  if (open) {
    const lower = parseCount(open[1]!)
    return lower === null ? null : { lower, upper: null, exact: false }
  }

  const range = /^([\d,]+)-([\d,]+)$/.exec(s)
  if (range) {
    const lower = parseCount(range[1]!)
    const upper = parseCount(range[2]!)
    if (lower === null || upper === null || lower > upper) return null
    return { lower, upper, exact: false }
  }
  return null
}

/**
 * Size band from headcount. Thresholds follow the common provider buckets:
 * 1 = solo, 2-10 = small, 11-50 = mid, 51+ = large. A range is banded by
 * its lower bound, except that "solo" needs the whole range to be 1, so a
 * "1-10" firm is small rather than solo. 0 gives no band.
 */
export function firmSizeBandFor(h: Headcount | null): FirmSizeBand | null {
  if (!h || (h.lower === 0 && h.upper === 0)) return null
  if (h.upper !== null && h.upper <= 1) return 'solo'
  if (h.lower <= 10) return 'small'
  if (h.lower <= 50) return 'mid'
  return 'large'
}

const looseHeadcount = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v, ctx) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && ['', 'null'].includes(v.trim().toLowerCase())) return null
  const h = parseHeadcount(v)
  if (!h) {
    ctx.addIssue({
      code: 'custom',
      message: `expected a headcount like 6, "1,204", "11-50" or "10,001+", got "${v}"`,
    })
    return z.NEVER
  }
  return h
})

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'valid', 'verified'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'invalid', 'unverified'])

const looseBool = z.union([z.boolean(), z.string(), z.number(), z.null(), z.undefined()]).transform((v, ctx) => {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === '') return null
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` })
  return z.NEVER
})

const looseUrl = looseText.transform((s) => {
  if (!s) return null
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
})

/** Accepts an object, a JSON string of one, or nothing. */
function jsonish<T extends z.ZodType>(schema: T, empty: unknown) {
  return z.preprocess((v) => {
    if (v === null || v === undefined) return empty
    if (typeof v === 'string') {
      const s = v.trim()
      if (s === '') return empty
      try {
        return JSON.parse(s)
      } catch {
        return v
      }
    }
    return v
  }, schema)
}

const CustodyAnswer = z.enum(['yes', 'no', 'unclear'])
export type CustodyAnswer = z.infer<typeof CustodyAnswer>

export const DECISION_MAKER_SOURCES = ['research_agent'] as const
export type DecisionMakerSource = (typeof DECISION_MAKER_SOURCES)[number]

// Every person field may be absent: Clay omits columns that found nothing.
const RawPersonSchema = z
  .object({
    full_name: looseText,
    title: looseText,
    email: looseText,
    email_source: looseText,
    email_verified: looseBool,
    linkedin_url: looseUrl,
    // Set by the GTM Decision Makers table (docs/clay/dm-table-setup.md). A
    // research_agent contact is a verified decision-maker: it is stored as the
    // firm's decision-maker and the firm's other contacts are demoted.
    decision_maker_source: looseText.transform((s) => s?.toLowerCase() ?? null).pipe(z.enum(DECISION_MAKER_SOURCES).nullable()),
  })
  .partial()

export const ClayCallbackRawSchema = z.object({
  firm_id: z.uuid(),
  company: jsonish(
    z.object({ headcount: looseHeadcount, description: looseText }).partial(),
    {},
  ).optional(),
  custody: jsonish(
    z
      .object({
        answer: looseText.transform((s) => (s ?? 'unclear').toLowerCase()).pipe(CustodyAnswer),
        evidence_url: looseUrl,
      })
      .partial(),
    {},
  ).optional(),
  people: jsonish(z.array(RawPersonSchema).max(MAX_PEOPLE_PER_CALLBACK), []).optional(),
})

export interface ClayPerson {
  fullName: string | null
  title: string | null
  email: string
  emailSource: string | null
  emailVerified: boolean | null
  linkedinUrl: string | null
  isDecisionMaker: boolean
  decisionMakerSource: DecisionMakerSource | null
}

export interface DroppedPerson {
  index: number
  reason: 'no_email' | 'invalid_email' | 'duplicate_email'
}

export interface ClayCallback {
  firmId: string
  /** Lower bound of the reported headcount (exact counts are their own bound). */
  headcount: number | null
  firmSizeBand: FirmSizeBand | null
  custody: { answer: CustodyAnswer; handlesCustody: boolean | null; evidenceUrl: string | null }
  people: ClayPerson[]
  droppedPeople: DroppedPerson[]
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// Titles SPEC §7 asks Clay to find that can say yes to a tool purchase.
// Office Manager is found (useful contact) but isn't the decision maker.
const DECISION_MAKER_RE = /\b(partner|managing|founder|founding|owner|principal|president|shareholder|solo|sole)\b/i

export function isDecisionMakerTitle(title: string | null): boolean {
  return title !== null && DECISION_MAKER_RE.test(title)
}

export function custodyToBoolean(answer: CustodyAnswer): boolean | null {
  return answer === 'yes' ? true : answer === 'no' ? false : null
}

export type ParseCallbackResult =
  | { ok: true; value: ClayCallback }
  | { ok: false; errors: string[]; firmId: string | null }

export function parseClayCallback(body: unknown): ParseCallbackResult {
  const parsed = ClayCallbackRawSchema.safeParse(body)
  if (!parsed.success) {
    const firmId =
      body && typeof body === 'object' && typeof (body as { firm_id?: unknown }).firm_id === 'string' &&
      z.uuid().safeParse((body as { firm_id: string }).firm_id).success
        ? (body as { firm_id: string }).firm_id
        : null
    return {
      ok: false,
      firmId,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }

  const raw = parsed.data
  const people: ClayPerson[] = []
  const droppedPeople: DroppedPerson[] = []
  const seen = new Set<string>()

  ;(raw.people ?? []).forEach((p, index) => {
    if (!p.email) return droppedPeople.push({ index, reason: 'no_email' })
    const email = p.email.toLowerCase()
    if (!EMAIL_RE.test(email) || email.length > 254) return droppedPeople.push({ index, reason: 'invalid_email' })
    if (seen.has(email)) return droppedPeople.push({ index, reason: 'duplicate_email' })
    seen.add(email)
    const title = p.title ?? null
    people.push({
      fullName: p.full_name ?? null,
      title,
      email,
      emailSource: p.email_source ?? null,
      emailVerified: p.email_verified ?? null,
      linkedinUrl: p.linkedin_url ?? null,
      // The research agent already verified this person as the decision-maker
      // (solo "Attorney" titles included), so the title regex doesn't apply.
      isDecisionMaker: p.decision_maker_source === 'research_agent' || isDecisionMakerTitle(title),
      decisionMakerSource: p.decision_maker_source ?? null,
    })
  })

  const answer: CustodyAnswer = raw.custody?.answer ?? 'unclear'
  return {
    ok: true,
    value: {
      firmId: raw.firm_id,
      headcount: raw.company?.headcount?.lower ?? null,
      firmSizeBand: firmSizeBandFor(raw.company?.headcount ?? null),
      custody: { answer, handlesCustody: custodyToBoolean(answer), evidenceUrl: raw.custody?.evidence_url ?? null },
      people,
      droppedPeople,
    },
  }
}
