// Retry with exponential backoff + full jitter, for flaky third-party APIs
// (Clay, HubSpot, Anthropic). Callers decide what is retryable.

export interface RetryOptions {
  attempts?: number        // total tries, including the first
  baseDelayMs?: number
  maxDelayMs?: number
  shouldRetry?: (err: unknown, attempt: number) => boolean
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  const base = options.baseDelayMs ?? 500
  const max = options.maxDelayMs ?? 10_000
  const shouldRetry = options.shouldRetry ?? (() => true)
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const random = options.random ?? Math.random

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      lastErr = err
      if (attempt === attempts || !shouldRetry(err, attempt)) break
      const delay = Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)))
      options.onRetry?.(err, attempt, delay)
      await sleep(delay)
    }
  }
  throw lastErr
}

/** HTTP statuses worth retrying: rate limits and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
