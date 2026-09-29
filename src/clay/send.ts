// Send firms to the Clay webhook table (SPEC §7, outbound).
//
// DRY RUN BY DEFAULT: prints the exact payloads and sends nothing. Pass
// --send to POST. Only firms in status 'new' are eligible; each successful
// POST moves the firm to 'sent_to_clay' with an audit event, and each
// failure is logged as clay_send_failed without changing status.

import type { Db } from '../lib/db.js'
import type { Logger } from '../lib/logger.js'
import { appendEvent, setFirmStatus } from '../lib/events.js'
import { isRetryableStatus, withRetry, type RetryOptions } from '../lib/retry.js'
import { buildOutboundPayload, type ClayOutbound } from '../../supabase/functions/_shared/clay-contract.ts'

export const DEFAULT_LIMIT = 10
export const MAX_LIMIT = 100
const REQUEST_TIMEOUT_MS = 15_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface EligibleFirm {
  id: string
  name: string
  domain: string | null
  city: string | null
  state: string | null
}

export async function selectEligibleFirms(db: Db, opts: { limit: number; firmIds?: string[] }): Promise<EligibleFirm[]> {
  let q = db
    .from('firms')
    .select('id, name, domain, city, state')
    .eq('status', 'new')
    .not('domain', 'is', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(opts.limit)
  if (opts.firmIds?.length) q = q.in('id', opts.firmIds)
  const { data, error } = await q
  if (error) throw new Error(`Selecting firms failed: ${error.message}`)
  return data
}

export interface ClaySender {
  url: string
  authToken?: string
  fetch?: typeof fetch
  retry?: RetryOptions
}

export async function postToClay(payload: object, sender: ClaySender): Promise<number> {
  const doFetch = sender.fetch ?? fetch
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sender.authToken) headers['x-clay-webhook-auth'] = sender.authToken

  return withRetry(
    async () => {
      const res = await doFetch(sender.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300)
        throw new HttpError(res.status, `Clay webhook returned ${res.status}${body ? `: ${body}` : ''}`)
      }
      return res.status
    },
    {
      attempts: 4,
      baseDelayMs: 1_000,
      shouldRetry: (err) => !(err instanceof HttpError) || isRetryableStatus(err.status),
      ...sender.retry,
    },
  )
}

export interface SendResult {
  sent: { firmId: string; httpStatus: number }[]
  failed: { firmId: string; error: string }[]
}

export async function sendFirmsToClay(
  db: Db,
  firms: EligibleFirm[],
  sender: ClaySender,
  log: Logger,
): Promise<SendResult> {
  const result: SendResult = { sent: [], failed: [] }

  // Sequential on purpose: tiny batches, and it keeps us well under any
  // webhook rate limit without having to know it.
  for (const firm of firms) {
    const payload = buildOutboundPayload(firm)
    try {
      const httpStatus = await postToClay(payload, sender)
      await setFirmStatus(db, firm.id, 'sent_to_clay', {
        reason: 'send_to_clay',
        payload: { http_status: httpStatus, callback_secret_ref: payload.callback_secret_ref },
      })
      result.sent.push({ firmId: firm.id, httpStatus })
      log.info('clay_sent', { firm_id: firm.id, domain: firm.domain, http_status: httpStatus })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ firmId: firm.id, error: message })
      log.error('clay_send_failed', { firm_id: firm.id, domain: firm.domain, error: message })
      await appendEvent(db, {
        entity: 'firm',
        entityId: firm.id,
        type: 'clay_send_failed',
        payload: { error: message, http_status: err instanceof HttpError ? err.status : null },
      }).catch((e) => log.error('clay_send_failed_event_not_logged', { firm_id: firm.id, error: String(e) }))
    }
  }
  return result
}
