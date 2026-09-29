// npm run clay:send -- [--limit 10] [--firm <uuid>]... [--send]
//
// Without --send this is a dry run: it prints the payloads that would be
// POSTed and touches nothing. Exit codes: 0 ok, 1 some sends failed,
// 2 usage/config error.

import { parseArgs } from 'node:util'
import { z } from 'zod'
import { parseConfig, requireKey } from '../lib/config.js'
import { createDb } from '../lib/db.js'
import { createLogger } from '../lib/logger.js'
import { buildOutboundPayload } from '../../supabase/functions/_shared/clay-contract.ts'
import { DEFAULT_LIMIT, MAX_LIMIT, selectEligibleFirms, sendFirmsToClay } from './send.js'

const USAGE = `Usage: npm run clay:send -- [options]

Sends firms in status 'new' to the Clay webhook table (SPEC §7).
Dry run by default: prints payloads, sends nothing.

Options:
  --limit <n>     Max firms (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).
  --firm <uuid>   Only this firm (repeatable). Must still be in status 'new'.
  --send          Actually POST to CLAY_WEBHOOK_URL and mark firms sent_to_clay.
  -h, --help      Show this help.`

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
        limit: { type: 'string', default: String(DEFAULT_LIMIT) },
        firm: { type: 'string', multiple: true, default: [] },
        send: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  const { values } = args
  if (values.help) {
    console.log(USAGE)
    return 0
  }

  const limit = Number(values.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    console.error(`--limit must be an integer from 1 to ${MAX_LIMIT}`)
    return 2
  }
  const badIds = values.firm.filter((id) => !z.uuid().safeParse(id).success)
  if (badIds.length) {
    console.error(`--firm must be a UUID: ${badIds.join(', ')}`)
    return 2
  }

  let config
  try {
    config = parseConfig(process.env)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }

  let url: string | undefined
  if (values.send) {
    try {
      url = requireKey(config, 'CLAY_WEBHOOK_URL')
    } catch {
      console.error('CLAY_WEBHOOK_URL is not set in .env. Nothing sent.')
      return 2
    }
    const host = new URL(url).hostname
    if (!/(^|\.)clay\.(com|run)$/.test(host)) {
      console.error(`Refusing to send: CLAY_WEBHOOK_URL host "${host}" is not a Clay domain.`)
      return 2
    }
  }

  const db = createDb(config)
  const firms = await selectEligibleFirms(db, { limit, firmIds: values.firm })

  if (!values.send) {
    console.log(`DRY RUN: nothing will be sent. ${firms.length} firm(s) eligible (status 'new', limit ${limit}).\n`)
    for (const f of firms) console.log(JSON.stringify(buildOutboundPayload(f)))
    if (firms.length) console.log('\nRe-run with --send to POST these to Clay.')
    return 0
  }

  if (!firms.length) {
    console.log("No firms in status 'new' to send.")
    return 0
  }

  const log = createLogger({ level: config.LOG_LEVEL, base: { job: 'clay_send' } })
  const result = await sendFirmsToClay(
    db,
    firms,
    { url: url!, ...(config.CLAY_WEBHOOK_AUTH_TOKEN ? { authToken: config.CLAY_WEBHOOK_AUTH_TOKEN } : {}) },
    log,
  )
  console.log(`\nSent ${result.sent.length}, failed ${result.failed.length}.`)
  for (const f of result.failed) console.log(`  failed ${f.firmId}: ${f.error}`)
  return result.failed.length ? 1 : 0
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
