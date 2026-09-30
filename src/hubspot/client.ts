// HubSpot REST transport: auth, typed errors, retries (SPEC §10).
//
// Retries 429 and 5xx with backoff, honoring Retry-After when HubSpot sends
// it. Requests that aren't idempotent (creates) only retry 429, because a
// 5xx or dropped connection may still have created the record and a retry
// would duplicate it. Never logs or echoes the service key.

import { z } from 'zod'
import { isRetryableStatus, withRetry, type RetryOptions } from '../lib/retry.js'

export const HUBSPOT_BASE_URL = 'https://api.hubapi.com'
const REQUEST_TIMEOUT_MS = 20_000

const ErrorBodySchema = z
  .object({
    message: z.string().optional(),
    category: z.string().optional(),
    correlationId: z.string().optional(),
    errors: z.array(z.object({ context: z.record(z.string(), z.unknown()).optional() }).loose()).optional(),
  })
  .loose()

export class HubSpotError extends Error {
  override readonly name = 'HubSpotError'

  constructor(
    readonly status: number,
    message: string,
    readonly category: string | undefined,
    readonly correlationId: string | undefined,
    /** Scopes HubSpot says the key is missing (403 MISSING_SCOPES). */
    readonly requiredScopes: string[],
    /** Server-requested wait before retrying, from Retry-After. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(message)
  }
}

/** A batch call that returned per-input errors (HTTP 207 or numErrors > 0). */
export class HubSpotBatchError extends Error {
  override readonly name = 'HubSpotBatchError'

  constructor(
    readonly errors: { message: string; category: string | undefined }[],
    /** Results for the inputs that did succeed, so callers can store their IDs. */
    readonly partialResults: unknown[],
  ) {
    super(`HubSpot batch had ${errors.length} error(s): ${errors.map((e) => e.message).join('; ').slice(0, 500)}`)
  }
}

/** Retry-After is either delay-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

async function toHubSpotError(res: Response, method: string, path: string, now: number): Promise<HubSpotError> {
  const text = await res.text().catch(() => '')
  let parsed: z.infer<typeof ErrorBodySchema> = {}
  try {
    parsed = ErrorBodySchema.parse(JSON.parse(text))
  } catch {
    // Not HubSpot's JSON error shape (e.g. an HTML 502 page); fall back to raw text.
  }
  const requiredScopes = [
    ...new Set(
      (parsed.errors ?? []).flatMap((e) => {
        const scopes = e.context?.['requiredGranularScopes']
        return Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : []
      }),
    ),
  ]
  const detail = parsed.message ?? text.slice(0, 300)
  const scopeNote = requiredScopes.length ? ` (missing scopes: ${requiredScopes.join(', ')})` : ''
  return new HubSpotError(
    res.status,
    `HubSpot ${method} ${path} returned ${res.status}${detail ? `: ${detail}` : ''}${scopeNote}`,
    parsed.category,
    parsed.correlationId,
    requiredScopes,
    parseRetryAfter(res.headers.get('retry-after'), now),
  )
}

export interface HubSpotClientOptions {
  serviceKey: string
  fetch?: typeof fetch
  retry?: RetryOptions
  baseUrl?: string
  now?: () => number
}

export interface RequestOptions {
  body?: unknown
  /**
   * Safe to repeat if the first attempt's outcome is unknown. Defaults to
   * true for everything except POST. Batch upsert/update/search POSTs pass
   * true explicitly; creates leave it false.
   */
  idempotent?: boolean
}

export interface HubSpotClient {
  request<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, schema: z.ZodType<T>, options?: RequestOptions): Promise<T>
}

export function createHubSpotClient(options: HubSpotClientOptions): HubSpotClient {
  const doFetch = options.fetch ?? fetch
  const base = options.baseUrl ?? HUBSPOT_BASE_URL
  const now = options.now ?? Date.now

  return {
    async request(method, path, schema, reqOptions = {}) {
      const idempotent = reqOptions.idempotent ?? method !== 'POST'
      const headers: Record<string, string> = { authorization: `Bearer ${options.serviceKey}`, accept: 'application/json' }
      if (reqOptions.body !== undefined) headers['content-type'] = 'application/json'

      const res = await withRetry(
        async () => {
          const r = await doFetch(`${base}${path}`, {
            method,
            headers,
            ...(reqOptions.body === undefined ? {} : { body: JSON.stringify(reqOptions.body) }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          })
          if (!r.ok) throw await toHubSpotError(r, method, path, now())
          return r
        },
        {
          attempts: 4,
          baseDelayMs: 1_000,
          shouldRetry: (err) => {
            // 429 means HubSpot rejected the request unprocessed: always safe.
            if (err instanceof HubSpotError) return err.status === 429 || (idempotent && isRetryableStatus(err.status))
            // Network error or timeout: outcome unknown.
            return idempotent
          },
          retryAfterMs: (err) => (err instanceof HubSpotError ? err.retryAfterMs : undefined),
          ...options.retry,
        },
      )

      const text = await res.text()
      const json: unknown = text ? JSON.parse(text) : null
      const parsed = schema.safeParse(json)
      if (!parsed.success) {
        throw new Error(`HubSpot ${method} ${path}: unexpected response shape: ${z.prettifyError(parsed.error).slice(0, 500)}`)
      }
      return parsed.data
    },
  }
}
