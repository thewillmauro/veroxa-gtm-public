import { describe, expect, it, vi } from 'vitest'
import { parseConfig, requireKey } from '../src/lib/config.js'
import { createLogger, redact } from '../src/lib/logger.js'
import { isRetryableStatus, withRetry } from '../src/lib/retry.js'
import { canonicalJson, stableHash } from '../src/lib/events.js'
import { emailDomain, normalizeDomain, normalizeEmail } from '../src/lib/email.js'

const VALID_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
}

describe('config', () => {
  it('parses a minimal env and applies defaults', () => {
    const config = parseConfig(VALID_ENV)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.CLAY_WEBHOOK_URL).toBeUndefined()
  })

  it('names missing keys without echoing secret values', () => {
    const run = () => parseConfig({ SUPABASE_URL: 'not-a-url', SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value' })
    expect(run).toThrow(/SUPABASE_URL/)
    expect(run).not.toThrow(/super-secret-value/)
  })

  it('treats blank values (KEY= in .env) as unset', () => {
    const config = parseConfig({ ...VALID_ENV, CLAY_WEBHOOK_URL: '', ANTHROPIC_API_KEY: '  ', LOG_LEVEL: '' })
    expect(config.CLAY_WEBHOOK_URL).toBeUndefined()
    expect(config.ANTHROPIC_API_KEY).toBeUndefined()
    expect(config.LOG_LEVEL).toBe('info')
  })

  it('rejects a short Clay callback secret', () => {
    expect(() => parseConfig({ ...VALID_ENV, CLAY_CALLBACK_SECRET: 'short' })).toThrow(/CLAY_CALLBACK_SECRET/)
  })

  it('requireKey fails loudly for an unset optional key', () => {
    expect(() => requireKey(parseConfig(VALID_ENV), 'HUBSPOT_SERVICE_KEY')).toThrow(/HUBSPOT_SERVICE_KEY/)
  })
})

describe('logger', () => {
  it('writes one JSON line with base fields and respects level', () => {
    const lines: string[] = []
    const log = createLogger({
      level: 'info',
      base: { svc: 'test' },
      write: (l) => lines.push(l),
      now: () => new Date('2026-01-01T00:00:00Z'),
    })
    log.debug('hidden')
    log.child({ firm_id: 'f1' }).info('hello', { n: 1 })
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'hello', svc: 'test', firm_id: 'f1', n: 1 })
  })

  it('redacts secret-looking keys at any depth', () => {
    expect(redact({ a: 1, headers: { Authorization: 'Bearer x', 'x-api-key': 'k' }, nested: [{ token: 't' }] })).toEqual({
      a: 1,
      headers: { Authorization: '[redacted]', 'x-api-key': '[redacted]' },
      nested: [{ token: '[redacted]' }],
    })
  })
})

describe('withRetry', () => {
  const noSleep = () => Promise.resolve()

  it('retries until success', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('stops when shouldRetry says no and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'))
    await expect(withRetry(fn, { sleep: noSleep, shouldRetry: () => false })).rejects.toThrow('fatal')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('caps backoff at maxDelayMs', async () => {
    const delays: number[] = []
    const fn = vi.fn().mockRejectedValue(new Error('x'))
    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, random: () => 0.999, sleep: noSleep, onRetry: (_e, _a, d) => delays.push(d) }),
    ).rejects.toThrow()
    expect(delays).toEqual([999, 1998, 2997, 2997])
  })

  it('classifies retryable HTTP statuses', () => {
    expect([408, 429, 500, 503].every(isRetryableStatus)).toBe(true)
    expect([400, 401, 404, 422].some(isRetryableStatus)).toBe(false)
  })
})

describe('stableHash', () => {
  it('ignores object key order and undefined values', () => {
    expect(stableHash({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(stableHash({ a: { c: 'x', d: [1, 2] }, b: 1, z: undefined }))
  })

  it('is sensitive to array order and values', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }))
  })
})

describe('email helpers', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeEmail('  Jane@SmithRivera.COM ')).toBe('jane@smithrivera.com')
    expect(() => normalizeEmail('not-an-email')).toThrow()
  })

  it('extracts domains and normalizes websites', () => {
    expect(emailDomain('jane@smithrivera.com')).toBe('smithrivera.com')
    expect(normalizeDomain('https://www.SmithRivera.com/family-law?x=1')).toBe('smithrivera.com')
    expect(normalizeDomain('smithrivera.com:443')).toBe('smithrivera.com')
  })
})
