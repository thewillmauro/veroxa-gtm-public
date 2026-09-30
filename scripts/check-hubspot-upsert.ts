// npx tsx --env-file=.env scripts/check-hubspot-upsert.ts
//
// Live check of upsertContacts (src/hubspot/crm.ts) against HubSpot:
// upserts a throwaway example.com contact (expect created), upserts it
// again with a changed property (expect the same ID, not created), then
// archives it. Only touches the record it created; the finally block
// archives it even if a step fails. Exit codes: 0 passed, 1 failed,
// 2 config error.

import { z } from 'zod'
import { parseConfig, requireKey } from '../src/lib/config.js'
import { createHubSpotClient } from '../src/hubspot/client.js'
import { upsertContact } from '../src/hubspot/crm.js'

export async function main(): Promise<number> {
  let key: string
  try {
    key = requireKey(parseConfig(process.env), 'HUBSPOT_SERVICE_KEY')
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }

  const client = createHubSpotClient({ serviceKey: key })
  const email = `gtm-upsert-test+${Date.now()}@example.com`
  let id: string | undefined
  let ok = true
  const check = (label: string, pass: boolean, detail = ''): void => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
    ok &&= pass
  }

  try {
    const first = await upsertContact(client, { email, properties: { firstname: 'UPSERT TEST' } })
    id = first.id
    check('first upsert creates the contact', first.created && first.key === email, `id ${first.id}, created ${first.created}`)

    const second = await upsertContact(client, { email: email.toUpperCase(), properties: { lastname: 'PATCHED' } })
    check('second upsert updates the same contact', second.id === first.id && !second.created, `id ${second.id}, created ${second.created}`)

    const read = await client.request(
      'GET',
      `/crm/v3/objects/contacts/${first.id}?properties=firstname,lastname,email`,
      z.object({ properties: z.record(z.string(), z.string().nullable()) }).loose(),
    )
    const p = read.properties
    check('both writes landed', p['firstname'] === 'UPSERT TEST' && p['lastname'] === 'PATCHED' && p['email'] === email)
  } catch (err) {
    check('upsert', false, err instanceof Error ? err.message : String(err))
  } finally {
    if (id) {
      try {
        await client.request('DELETE', `/crm/v3/objects/contacts/${id}`, z.unknown())
        console.log(`PASS  archived contact ${id}`)
      } catch (err) {
        ok = false
        console.log(`FAIL  cleanup: archive contact ${id} by hand in HubSpot (${err instanceof Error ? err.message : String(err)})`)
      }
    }
  }
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
