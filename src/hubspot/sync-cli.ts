// npm run hubspot:sync -- [--send]
//
// Syncs researched firms and their decision-makers to HubSpot (SPEC §10,
// src/hubspot/sync-firms.ts). DRY RUN BY DEFAULT: reads Supabase and
// HubSpot and prints every create, update, conflict and skip, writing
// nothing. --send takes the HubSpot sync lock, writes to HubSpot, stores
// IDs and last_synced_at back in Supabase, moves qualified firms to synced,
// and appends events.
//
// Exit codes: 0 ok, 1 conflicts or failures to look at, 2 usage/config
// error, 3 skipped because another HubSpot sync holds the lock.

import { parseArgs } from 'node:util'
import { parseConfig, requireKey } from '../lib/config.js'
import { createDb } from '../lib/db.js'
import { HUBSPOT_SYNC_LOCK, withJobLock } from '../lib/job-lock.js'
import { createLogger } from '../lib/logger.js'
import { createHubSpotClient } from './client.js'
import { executeSync, loadSyncInput, planSync, statusAfterSync, type SyncPlan, type SyncSummary } from './sync-firms.js'

const USAGE = `Usage: npm run hubspot:sync -- [--send]

Syncs researched firms (companies) and their eligible decision-makers
(contacts) to HubSpot. Dry run by default.

Options:
  --send       Write to HubSpot and store IDs back (takes the HubSpot sync lock).
  -h, --help   Show this help.`

function printPlan(plan: SyncPlan): void {
  console.log(`Companies (${plan.companies.length}):`)
  for (const a of plan.companies) {
    const status = a.firm.status === statusAfterSync(a.firm.status) ? a.firm.status : `${a.firm.status} -> ${statusAfterSync(a.firm.status)}`
    if (a.kind === 'create') {
      console.log(`  CREATE  ${a.firm.name} (${a.firm.domain}) [${status}]`)
      console.log(`          ${Object.entries(a.properties).filter(([k]) => k !== 'veroxa_score_breakdown').map(([k, v]) => `${k}=${v}`).join(', ')}`)
    } else {
      const w = Object.keys(a.writes.write)
      console.log(`  ${w.length ? 'UPDATE ' : 'NOCHANGE'} ${a.firm.name} (${a.firm.domain}) -> HubSpot ${a.hubspotId} via ${a.how} [${status}]`)
      if (w.length) console.log(`          write: ${w.map((k) => `${k}=${k === 'veroxa_score_breakdown' ? '(breakdown)' : a.writes.write[k]}`).join(', ')}`)
      for (const c of a.writes.conflicts) {
        console.log(`          CONFLICT ${c.property}: HubSpot has "${c.hubspotValue}" (edited by ${c.editedBy} at ${c.editedAt}), Supabase wants "${c.wanted}". Left unchanged.`)
      }
      if (a.duplicateIds.length) console.log(`          NOTE other companies share this domain: ${a.duplicateIds.join(', ')} (using the oldest)`)
    }
  }
  for (const s of plan.staleIds) console.log(`  NOTE    ${s.firm.name}: stored HubSpot id ${s.storedId} not found in HubSpot; relinking by domain`)
  for (const f of plan.firmsWithoutDomain) console.log(`  SKIP    ${f.name}: no domain`)

  console.log(`\nContacts to sync (${plan.contacts.length}):`)
  for (const a of plan.contacts) {
    if (a.kind === 'create') {
      const { email: _e, ...rest } = a.properties
      console.log(`  CREATE  ${a.contact.email} @ ${a.firm.name}  (${Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(', ')})`)
    } else console.log(`  LINK    ${a.contact.email} @ ${a.firm.name} -> HubSpot ${a.hubspotId}`)
  }
  console.log(`\nContacts skipped (${plan.skipped.length}):`)
  for (const s of plan.skipped) console.log(`  SKIP    ${s.contact.email ?? s.contact.full_name ?? s.contact.id} @ ${s.firm.name}: ${s.reason}${s.detail ? ` [${s.detail}]` : ''}`)
}

function printSummary(s: SyncSummary): void {
  console.log(`\nCompanies: ${s.companiesCreated} created, ${s.companiesUpdated} updated, ${s.companiesUnchanged} unchanged.`)
  console.log(`Contacts:  ${s.contactsCreated} created, ${s.contactsLinked} linked. Skip events logged: ${s.skippedLogged}.`)
  console.log(`Firm status changes: ${s.statusChanged}.`)
  for (const c of s.conflicts) console.log(`CONFLICT ${c.firm}: ${c.conflicts.map((x) => x.property).join(', ')} left unchanged`)
}

export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { send: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
    }))
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }

  let config
  let key: string
  try {
    config = parseConfig(process.env)
    key = requireKey(config, 'HUBSPOT_SERVICE_KEY')
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  const log = createLogger({ level: config.LOG_LEVEL, base: { job: 'hubspot-sync' } })
  const db = createDb(config)
  const client = createHubSpotClient({ serviceKey: key })
  const ownerId = config.HUBSPOT_OWNER_ID

  const build = async (): Promise<SyncPlan> => planSync(client, await loadSyncInput(db), ownerId ? { ownerId } : {})

  if (!values.send) {
    console.log(`DRY RUN: nothing will be written.${ownerId ? '' : ' (HUBSPOT_OWNER_ID not set: created records get no owner.)'}\n`)
    const plan = await build()
    printPlan(plan)
    const conflicts = plan.companies.some((a) => a.kind === 'update' && a.writes.conflicts.length)
    return conflicts ? 1 : 0
  }

  const result = await withJobLock(db, HUBSPOT_SYNC_LOCK, async () => {
    // Plan inside the lock so no other run can change HubSpot in between.
    const plan = await build()
    printPlan(plan)
    return executeSync(db, client, plan, log)
  })
  if (!result.ran) {
    console.log(`Skipped: another HubSpot sync holds the "${HUBSPOT_SYNC_LOCK}" lock.`)
    return 3
  }
  printSummary(result.value)
  return result.value.conflicts.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(2)
    },
  )
}
