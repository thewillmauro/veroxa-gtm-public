// clay-callback request handling, runtime-agnostic: no Deno or Node APIs,
// only Request/Response/crypto.subtle. index.ts wires in Supabase; tests
// wire in fakes. Rules from SPEC §7:
//   bad secret -> 401; idempotent on firm_id + payload hash; Zod validation;
//   raw payload logged to pipeline_events; contacts upserted by email;
//   status advanced to enriched.

import { canonicalHash } from '../_shared/canonical-json.ts'
import {
  CLAY_CALLBACK_SECRET_HEADER,
  MAX_CALLBACK_BYTES,
  parseClayCallback,
  type ClayCallback,
} from '../_shared/clay-contract.ts'

export type ApplyResult =
  | { result: 'applied'; status_from: string; status_to: string; contacts_upserted: number; contacts_owned_by_other_firm: string[]; demoted_contacts?: string[] }
  | { result: 'duplicate' }
  | { result: 'unknown_firm' }
  | { result: 'research_email_domain_mismatch'; firm_domain: string | null; emails: string[] }

export interface CallbackDeps {
  /** Accepted secrets. A list so a rotation can briefly accept two (ADR 0008). */
  secrets: string[]
  apply(input: { callback: ClayCallback; idempotencyKey: string; raw: unknown }): Promise<ApplyResult>
  logRejected(input: { firmId: string | null; reason: string; errors?: string[]; raw?: unknown }): Promise<void>
  log?(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void
  /** Injectable for tests; defaults to setTimeout. */
  sleep?(ms: number): Promise<void>
}

// Errors from the database call that are worth retrying: platform clock skew
// between the API gateway and PostgREST ("JWT issued at future", seen on an
// M3 callback 2026-09-28), and network or upstream hiccups. Retrying is safe
// because apply_clay_callback is atomic and idempotent on the payload hash.
const TRANSIENT_APPLY_ERROR = /JWT issued at future|fetch failed|network|timed? ?out|ECONNRESET|socket hang up|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Timeout/i
export const APPLY_RETRY_DELAYS_MS = [300, 1000]

export function isTransientApplyError(err: unknown): boolean {
  return TRANSIENT_APPLY_ERROR.test(err instanceof Error ? err.message : String(err))
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
}

/** Constant-time comparison: compares fixed-length digests, never early-exits. */
export async function secretMatches(provided: string | null, accepted: string[]): Promise<boolean> {
  if (!provided) return false
  const p = await sha256(provided)
  let ok = false
  for (const secret of accepted) {
    if (!secret) continue
    const s = await sha256(secret)
    let diff = 0
    for (let i = 0; i < s.length; i++) diff |= s[i]! ^ p[i]!
    ok = ok || diff === 0
  }
  return ok
}

/** Truncate what we store for rejected payloads; they may be huge or hostile. */
function preview(raw: unknown): unknown {
  const s = JSON.stringify(raw) ?? ''
  return s.length <= 8_000 ? raw : { truncated: true, head: s.slice(0, 8_000) }
}

export async function handleClayCallback(req: Request, deps: CallbackDeps): Promise<Response> {
  const log = deps.log ?? (() => {})

  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  if (deps.secrets.filter(Boolean).length === 0) {
    log('error', 'clay_callback_no_secret_configured')
    return json(500, { error: 'not_configured' })
  }
  // Auth first, before reading the body: unauthenticated input is never parsed or stored.
  if (!(await secretMatches(req.headers.get(CLAY_CALLBACK_SECRET_HEADER), deps.secrets))) {
    log('warn', 'clay_callback_unauthorized')
    return json(401, { error: 'unauthorized' })
  }

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_CALLBACK_BYTES) return json(413, { error: 'payload_too_large' })
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_CALLBACK_BYTES) return json(413, { error: 'payload_too_large' })

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    await deps.logRejected({ firmId: null, reason: 'invalid_json', raw: { head: text.slice(0, 2_000) } })
    return json(400, { error: 'invalid_json' })
  }

  const parsed = parseClayCallback(raw)
  if (!parsed.ok) {
    await deps.logRejected({ firmId: parsed.firmId, reason: 'validation_failed', errors: parsed.errors, raw: preview(raw) })
    log('warn', 'clay_callback_invalid', { firm_id: parsed.firmId, errors: parsed.errors })
    return json(422, { error: 'validation_failed', details: parsed.errors })
  }

  const callback = parsed.value
  const idempotencyKey = `clay_callback:${callback.firmId}:${await canonicalHash(raw)}`
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let result: ApplyResult | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      result = await deps.apply({ callback, idempotencyKey, raw })
      break
    } catch (err) {
      const delay = APPLY_RETRY_DELAYS_MS[attempt]
      if (delay === undefined || !isTransientApplyError(err)) throw err
      log('warn', 'clay_callback_apply_retry', {
        firm_id: callback.firmId,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      })
      await sleep(delay)
    }
  }

  if (result.result === 'research_email_domain_mismatch') {
    // Nothing was written. The waterfall found an email off the firm's domain,
    // most likely a different person with the same name.
    await deps.logRejected({
      firmId: callback.firmId,
      reason: 'research_email_domain_mismatch',
      errors: [`email domain is not ${result.firm_domain}: ${result.emails.join(', ')}`],
      raw: preview(raw),
    })
    log('warn', 'clay_callback_domain_mismatch', { firm_id: callback.firmId, firm_domain: result.firm_domain, emails: result.emails })
    return json(422, {
      error: 'research_email_domain_mismatch',
      details: [`decision-maker email must be on ${result.firm_domain}; got ${result.emails.join(', ')}`],
      firm_id: callback.firmId,
    })
  }

  if (result.result === 'unknown_firm') {
    await deps.logRejected({ firmId: null, reason: 'unknown_firm', raw: preview(raw) })
    log('warn', 'clay_callback_unknown_firm', { firm_id: callback.firmId })
    return json(404, { error: 'unknown_firm', firm_id: callback.firmId })
  }

  log('info', 'clay_callback_processed', { firm_id: callback.firmId, ...result })
  return json(200, {
    ...result,
    firm_id: callback.firmId,
    people_dropped: callback.droppedPeople.length,
  })
}
