// npm run reply -- --email <address> [--send]
// npm run reply -- --signups [--send]
//
// Records a reply (src/hubspot/reply.ts): firm -> replied, contact_replied
// event, and one Attorney Pilot deal per firm in the "Replied" stage.
// DRY RUN BY DEFAULT: prints what would happen. --send takes the HubSpot
// sync lock and writes.
//
// Exit codes: 0 ok, 1 some targets couldn't be recorded, 2 usage/config
// error, 3 skipped because another HubSpot sync holds the lock.

import { parseArgs } from 'node:util'
import { parseConfig, requireKey } from '../lib/config.js'
import { createDb } from '../lib/db.js'
import { HUBSPOT_SYNC_LOCK, withJobLock } from '../lib/job-lock.js'
import { createHubSpotClient } from './client.js'
import { planReply, recordReply, targetFromEmail, targetsFromSignups, type ReplyPlan } from './reply.js'

const USAGE = `Usage:
  npm run reply -- --email <address> [--send]   a pipeline contact replied
  npm run reply -- --signups [--send]           signups matched to pipeline firms

Marks the firm replied and creates its Attorney Pilot deal. Dry run by default.

Options:
  --email <address>  The contact who replied.
  --signups          Treat matched inbound signups as replies.
  --send             Write (takes the HubSpot sync lock).
  -h, --help         Show this help.`

function describe(p: ReplyPlan): string {
  const who = p.target.contact?.email ?? '(no contact)'
  if (!p.ok) return `CANNOT  ${p.target.firm.name} / ${who}: ${p.problem}`
  const deal = p.deal === 'create' ? `create deal "${p.dealName}" in Attorney Pilot > Replied` : `deal ${p.target.firm.hubspot_deal_id} already exists`
  const contactNote = p.target.contact && !p.target.contact.hubspot_contact_id ? ' (contact not in HubSpot; deal linked to company only)' : ''
  return `REPLY   ${p.target.firm.name} / ${who} [${p.target.firm.status} -> replied, via ${p.target.source}]: ${deal}${contactNote}`
}

export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: 'string' },
        signups: { type: 'boolean', default: false },
        send: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }))
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (!!values.email === values.signups) {
    console.error(`Pass exactly one of --email or --signups.\n\n${USAGE}`)
    return 2
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
  const db = createDb(config)
  const client = createHubSpotClient({ serviceKey: key })

  const loadPlans = async (): Promise<ReplyPlan[]> =>
    (values.email ? [await targetFromEmail(db, values.email)] : await targetsFromSignups(db)).map(planReply)

  if (!values.send) {
    console.log('DRY RUN: nothing will be written.\n')
    const plans = await loadPlans()
    if (!plans.length) console.log('No replies to record.')
    for (const p of plans) console.log(describe(p))
    return plans.some((p) => !p.ok) ? 1 : 0
  }

  const ownerId = config.HUBSPOT_OWNER_ID
  const result = await withJobLock(db, HUBSPOT_SYNC_LOCK, async () => {
    let failed = 0
    for (const p of await loadPlans()) {
      console.log(describe(p))
      if (!p.ok) {
        failed++
        continue
      }
      const r = await recordReply(db, client, p, ownerId ? { ownerId } : {})
      console.log(`        done: deal ${r.dealId}${r.created ? ' (created)' : ' (existing)'}`)
    }
    return failed
  })
  if (!result.ran) {
    console.log(`Skipped: another HubSpot sync holds the "${HUBSPOT_SYNC_LOCK}" lock.`)
    return 3
  }
  return result.value ? 1 : 0
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
