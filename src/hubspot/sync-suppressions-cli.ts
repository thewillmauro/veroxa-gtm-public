// npm run hubspot:sync-suppressions -- [--apply]
//
// Mirrors GTM suppressions (unsubscribed, bounced, complaint, manual) to
// veroxa_email_opt_out / veroxa_opt_out_reason / veroxa_opt_out_at on
// contacts that already exist in HubSpot. See sync-suppressions.ts.
//
// DRY RUN BY DEFAULT: reads Supabase and HubSpot, prints what would change,
// writes nothing. --apply takes the HubSpot sync lock, writes the updates,
// and appends a hubspot_suppressions_mirrored event.
//
// Exit codes: 0 ok, 1 some batches failed, 2 usage/config error,
// 3 skipped because another HubSpot sync holds the lock.

import { parseArgs } from 'node:util'
import { parseConfig, requireKey } from '../lib/config.js'
import { createDb } from '../lib/db.js'
import { appendEvent } from '../lib/events.js'
import { HUBSPOT_SYNC_LOCK, withJobLock } from '../lib/job-lock.js'
import { createLogger } from '../lib/logger.js'
import { createHubSpotClient } from './client.js'
import { loadMirroredSuppressions, syncSuppressionsToHubSpot, type SyncSummary } from './sync-suppressions.js'

const USAGE = `Usage: npm run hubspot:sync-suppressions -- [--apply]

Mirrors GTM suppressions to existing HubSpot contacts. Never creates contacts;
skips existing_customer. Dry run by default.

Options:
  --apply      Write the updates (takes the HubSpot sync lock).
  -h, --help   Show this help.`

function print(summary: SyncSummary, apply: boolean): void {
  console.log(`Suppressions considered: ${summary.considered}`)
  console.log(`  not in HubSpot (skipped): ${summary.notInHubSpot}`)
  console.log(`  already current:          ${summary.alreadyCurrent}`)
  if (apply) console.log(`  updated:                  ${summary.updated.length}`)
  else {
    console.log(`  would update:             ${summary.wouldUpdate.length}`)
    for (const e of summary.wouldUpdate) console.log(`    ${e}`)
  }
  for (const f of summary.failed) console.log(`  FAILED batch of ${f.emails.length}: ${f.error}`)
}

export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { apply: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
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

  const log = createLogger({ level: config.LOG_LEVEL, base: { job: 'hubspot-sync-suppressions' } })
  const db = createDb(config)
  const client = createHubSpotClient({ serviceKey: key })
  const apply = values.apply

  const run = async (): Promise<SyncSummary> => {
    const suppressions = await loadMirroredSuppressions(db)
    const summary = await syncSuppressionsToHubSpot(suppressions, client, { apply, log })
    if (apply) {
      await appendEvent(db, {
        entity: 'system',
        type: 'hubspot_suppressions_mirrored',
        payload: {
          considered: summary.considered,
          updated: summary.updated.length,
          already_current: summary.alreadyCurrent,
          not_in_hubspot: summary.notInHubSpot,
          failed_batches: summary.failed.length,
        },
      })
    }
    return summary
  }

  if (!apply) {
    console.log('DRY RUN: nothing will be written.\n')
    const summary = await run()
    print(summary, false)
    return summary.failed.length ? 1 : 0
  }

  const result = await withJobLock(db, HUBSPOT_SYNC_LOCK, run)
  if (!result.ran) {
    console.log(`Skipped: another HubSpot sync holds the "${HUBSPOT_SYNC_LOCK}" lock.`)
    return 3
  }
  print(result.value, true)
  return result.value.failed.length ? 1 : 0
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
