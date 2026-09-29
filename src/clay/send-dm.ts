// npm run clay:send-dm -- [--firm <domain|id|name>]... [--send]
//
// Sends verified decision-makers to the GTM Decision Makers Clay table
// (docs/clay/dm-table-setup.md), one payload per firm:
//   { firm_id, firm_name, domain, dm_name, dm_title, evidence_url }
//
// DRY RUN BY DEFAULT: prints what would be sent and why others are skipped.
// Only deliverable firms go (src/research/delivery.ts): route send, or
// needs_review approved via `npm run review`; never rejected, no_contact, or
// already sent. Each success is a dm_sent_to_clay event (idempotent per
// research id); each failure is dm_send_failed. Firm status doesn't change.
//
// Exit codes: 0 ok, 1 some sends failed, 2 usage/config error.

import { parseArgs } from 'node:util'
import { parseConfig, requireKey } from '../lib/config.js'
import { createDb, type Db } from '../lib/db.js'
import { appendEvent } from '../lib/events.js'
import { createLogger, type Logger } from '../lib/logger.js'
import { ClayDmOutboundSchema, type ClayDmOutbound } from '../../supabase/functions/_shared/clay-contract.ts'
import { eligibility, findFirm, loadFirmResearch, type FirmResearch } from '../research/delivery.js'
import { HttpError, postToClay, type ClaySender } from './send.js'

/**
 * Name as the email waterfall should see it: without "Esq." (it isn't part of
 * the person's name and hurts matching). Generational suffixes stay: Jr. and
 * III are different people at Ashford Bell & Carter.
 */
export function waterfallName(name: string): string {
  return name
    .replace(/,?\s*\besq(uire)?\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim()
}

export function buildDmPayload(r: FirmResearch): ClayDmOutbound {
  if (!r.dm) throw new Error(`${r.firmName} has no decision-maker`)
  return ClayDmOutboundSchema.parse({
    firm_id: r.firmId,
    firm_name: r.firmName,
    domain: r.domain,
    dm_name: waterfallName(r.dm.name),
    dm_title: r.dm.title,
    evidence_url: r.dm.evidence_url,
  })
}

export interface DmPlan {
  send: FirmResearch[]
  skip: { firm: FirmResearch; why: string }[]
}

export function planDmSend(all: FirmResearch[]): DmPlan {
  const plan: DmPlan = { send: [], skip: [] }
  for (const r of all) {
    const e = eligibility(r)
    if (e.deliver) plan.send.push(r)
    else plan.skip.push({ firm: r, why: e.why })
  }
  return plan
}

export async function sendDms(db: Db, firms: FirmResearch[], sender: ClaySender, log: Logger) {
  const result = { sent: [] as string[], failed: [] as { firm: string; error: string }[] }
  for (const r of firms) {
    const payload = buildDmPayload(r)
    try {
      const httpStatus = await postToClay(payload, sender)
      const ev = await appendEvent(db, {
        entity: 'firm',
        entityId: r.firmId,
        type: 'dm_sent_to_clay',
        payload: { research_id: r.researchId, http_status: httpStatus, payload: { ...payload } },
        idempotencyKey: `dm_sent:${r.researchId}`,
      })
      if (!ev.inserted) log.warn('dm_sent_already_recorded', { firm_id: r.firmId, research_id: r.researchId })
      result.sent.push(r.firmName)
      log.info('dm_sent', { firm_id: r.firmId, dm: r.dm?.name, http_status: httpStatus })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ firm: r.firmName, error: message })
      log.error('dm_send_failed', { firm_id: r.firmId, error: message })
      await appendEvent(db, {
        entity: 'firm',
        entityId: r.firmId,
        type: 'dm_send_failed',
        payload: { research_id: r.researchId, error: message, http_status: err instanceof HttpError ? err.status : null },
      }).catch((e) => log.error('dm_send_failed_event_not_logged', { firm_id: r.firmId, error: String(e) }))
    }
  }
  return result
}

const USAGE = `Usage: npm run clay:send-dm -- [--firm <domain|id|name>]... [--send]

Sends verified decision-makers to the GTM Decision Makers Clay table.
Dry run by default: prints payloads and skip reasons, sends nothing.

Options:
  --firm <ref>   Only this firm (repeatable). Must still be deliverable.
  --send         Actually POST to CLAY_DM_WEBHOOK_URL.
  -h, --help     Show this help.`

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
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
      url = requireKey(config, 'CLAY_DM_WEBHOOK_URL')
    } catch {
      console.error('CLAY_DM_WEBHOOK_URL is not set in .env. Nothing sent.')
      return 2
    }
    const host = new URL(url).hostname
    if (!/(^|\.)clay\.(com|run)$/.test(host)) {
      console.error(`Refusing to send: CLAY_DM_WEBHOOK_URL host "${host}" is not a Clay domain.`)
      return 2
    }
    if (url === config.CLAY_WEBHOOK_URL) {
      console.error('Refusing to send: CLAY_DM_WEBHOOK_URL is the GTM Firms webhook. Use the GTM Decision Makers table URL.')
      return 2
    }
  }

  const db = createDb(config)
  let all = await loadFirmResearch(db)
  if (values.firm.length) {
    const picked: FirmResearch[] = []
    for (const ref of values.firm) {
      const f = findFirm(all, ref)
      if ('error' in f) {
        console.error(f.error)
        return 2
      }
      picked.push(f)
    }
    all = picked
  }
  const plan = planDmSend(all)

  if (!values.send) {
    console.log(`DRY RUN: nothing will be sent. ${plan.send.length} deliverable, ${plan.skip.length} skipped.\n`)
    for (const r of plan.send) console.log(JSON.stringify(buildDmPayload(r)))
    if (plan.skip.length) {
      console.log('\nSkipped:')
      for (const s of plan.skip) console.log(`  ${s.firm.firmName}: ${s.why}`)
    }
    if (plan.send.length) console.log('\nRe-run with --send to POST these to the GTM Decision Makers table.')
    return 0
  }
  if (!plan.send.length) {
    console.log('Nothing deliverable to send.')
    return 0
  }

  const log = createLogger({ level: config.LOG_LEVEL, base: { job: 'clay_send_dm' } })
  const result = await sendDms(db, plan.send, { url: url!, ...(config.CLAY_WEBHOOK_AUTH_TOKEN ? { authToken: config.CLAY_WEBHOOK_AUTH_TOKEN } : {}) }, log)
  console.log(`\nSent ${result.sent.length}, failed ${result.failed.length}.`)
  for (const f of result.failed) console.log(`  failed ${f.firm}: ${f.error}`)
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
