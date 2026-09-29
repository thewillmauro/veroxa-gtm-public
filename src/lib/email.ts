// Email normalization shared by every boundary that accepts an address
// (Clay callback, inbound mirror, seed import). The DB enforces lowercase
// via check constraints; this keeps callers from tripping them.

import { z } from 'zod'

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254))

export function normalizeEmail(raw: string): string {
  return EmailSchema.parse(raw)
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

/** Normalize a website or domain to a bare lowercase host: "https://www.Foo.com/x" -> "foo.com". */
export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase()
  s = s.replace(/^[a-z]+:\/\//, '')
  s = s.split(/[/?#]/)[0] ?? ''
  s = s.replace(/:\d+$/, '')
  s = s.replace(/^www\./, '')
  return s.replace(/\.$/, '')
}
