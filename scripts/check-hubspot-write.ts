// npx tsx --env-file=.env scripts/check-hubspot-write.ts
//
// One-off check that HUBSPOT_SERVICE_KEY can write contacts and companies.
// For each object type it creates a throwaway record with a unique
// timestamped email/domain, PATCHes one property, then archives it.
// It only ever touches the records it created; the finally block archives
// them even when an earlier step fails. Exit codes: 0 all passed,
// 1 some step failed, 2 config error.

import { parseConfig, requireKey } from '../src/lib/config.js'

const BASE = 'https://api.hubapi.com'

interface StepResult {
  ok: boolean
  status: number
  body: unknown
}

async function call(key: string, method: string, path: string, body?: unknown): Promise<StepResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Non-JSON error page; keep the raw text.
  }
  return { ok: res.ok, status: res.status, body: parsed }
}

/** HubSpot's error message plus any scopes it says are missing. */
function describeError(body: unknown): string {
  if (typeof body !== 'object' || body === null) return String(body).slice(0, 300)
  const b = body as { message?: unknown; category?: unknown; errors?: unknown }
  const parts = [typeof b.category === 'string' ? b.category : '', typeof b.message === 'string' ? b.message : '']
  if (Array.isArray(b.errors)) {
    for (const e of b.errors as Array<{ context?: { requiredGranularScopes?: unknown } }>) {
      const scopes = e.context?.requiredGranularScopes
      if (Array.isArray(scopes)) parts.push(`required scopes: ${scopes.join(', ')}`)
    }
  }
  return parts.filter(Boolean).join(' | ')
}

function report(label: string, r: StepResult): boolean {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${label}  (HTTP ${r.status})${r.ok ? '' : `\n      ${describeError(r.body)}`}`)
  return r.ok
}

interface ObjectCheck {
  type: 'contacts' | 'companies'
  create: Record<string, string>
  patch: Record<string, string>
}

async function checkObject(key: string, check: ObjectCheck): Promise<boolean> {
  let id: string | undefined
  let archived = false
  let allOk = true
  try {
    const created = await call(key, 'POST', `/crm/v3/objects/${check.type}`, { properties: check.create })
    allOk = report(`create ${check.type}`, created) && allOk
    if (!created.ok) {
      if (created.status >= 500) {
        console.log(`      A 5xx create may still have succeeded. Search HubSpot for ${Object.values(check.create)[0]} and archive it by hand.`)
      }
      return false
    }
    id = String((created.body as { id?: unknown }).id ?? '')
    if (!id) {
      console.log('FAIL  create returned no id')
      return false
    }

    const patched = await call(key, 'PATCH', `/crm/v3/objects/${check.type}/${id}`, { properties: check.patch })
    allOk = report(`patch ${check.type} ${id}`, patched) && allOk

    const deleted = await call(key, 'DELETE', `/crm/v3/objects/${check.type}/${id}`)
    archived = deleted.ok
    allOk = report(`archive ${check.type} ${id}`, deleted) && allOk
  } catch (err) {
    console.log(`FAIL  ${check.type}: ${err instanceof Error ? err.message : String(err)}`)
    allOk = false
  } finally {
    if (id && !archived) {
      const retry = await call(key, 'DELETE', `/crm/v3/objects/${check.type}/${id}`).catch(() => undefined)
      if (retry?.ok) console.log(`      cleanup: archived ${check.type} ${id}`)
      else console.log(`      cleanup FAILED: archive ${check.type} ${id} by hand in HubSpot`)
    }
  }
  return allOk
}

export async function main(): Promise<number> {
  let key: string
  try {
    key = requireKey(parseConfig(process.env), 'HUBSPOT_SERVICE_KEY')
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }

  const ts = Date.now()
  const checks: ObjectCheck[] = [
    {
      type: 'contacts',
      create: { email: `gtm-scope-test+${ts}@example.com`, firstname: 'SCOPE TEST' },
      patch: { lastname: 'PATCHED' },
    },
    {
      type: 'companies',
      create: { domain: `scope-test-${ts}.example.com`, name: 'SCOPE TEST' },
      patch: { description: 'PATCHED' },
    },
  ]

  let ok = true
  for (const check of checks) {
    console.log(`\n== ${check.type}`)
    ok = (await checkObject(key, check)) && ok
  }
  console.log(`\n${ok ? 'All write checks passed.' : 'Some write checks failed; see required scopes above.'}`)
  return ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(2)
    },
  )
}
