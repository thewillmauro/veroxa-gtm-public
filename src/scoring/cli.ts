// npm run score -- [--firm <domain|id|name>]... [--send]
//
// Scores researched firms with SPEC §9 v1 (src/scoring/score.ts).
// DRY RUN BY DEFAULT: prints each firm's score and breakdown, writes nothing.
// --send stores fit_score + score_breakdown, moves the firm to qualified /
// scored / disqualified, and appends a firm_scored event (idempotent per
// firm + breakdown). Firms already past scoring (synced, drafted, contacted,
// replied) get the new score but keep their status.
//
// Exit codes: 0 ok, 1 some writes failed, 2 usage/config error.

import { parseArgs } from 'node:util'
import { parseConfig } from '../lib/config.js'
import { createDb, type Db, type PipelineStatus } from '../lib/db.js'
import { appendEvent, setFirmStatus, stableHash } from '../lib/events.js'
import { createLogger } from '../lib/logger.js'
import type { Json } from '../lib/database.types.js'
import { scoreFirm, type DmContact, type ScoreResult } from './score.js'

/** Statuses scoring may move a firm between. Later stages keep their status. */
export const SCORABLE: readonly PipelineStatus[] = ['researched', 'scored', 'qualified', 'disqualified']
const LATER: readonly PipelineStatus[] = ['synced', 'drafted', 'contacted', 'replied']

export interface ScoredFirm {
  firmId: string
  name: string
  domain: string | null
  status: PipelineStatus
  result: ScoreResult
}

export async function loadAndScore(db: Db): Promise<ScoredFirm[]> {
  const { data: firms, error } = await db
    .from('firms')
    .select('id, name, domain, status, state, county, handles_custody, firm_size_band')
    .in('status', [...SCORABLE, ...LATER])
    .order('name')
  if (error) throw new Error(`load firms: ${error.message}`)
  if (!firms.length) return []

  const { data: contacts, error: cErr } = await db
    .from('contacts')
    .select('firm_id, email, email_verified, unsubscribed')
    .eq('is_decision_maker', true)
    .in('firm_id', firms.map((f) => f.id))
  if (cErr) throw new Error(`load contacts: ${cErr.message}`)

  const emails = contacts.map((c) => c.email).filter((e): e is string => !!e)
  const { data: sups, error: sErr } = emails.length
    ? await db.from('suppressions').select('email, reason, source').in('email', emails)
    : { data: [], error: null }
  if (sErr) throw new Error(`load suppressions: ${sErr.message}`)
  const supByEmail = new Map(sups.map((s) => [s.email, { reason: s.reason, source: s.source }]))

  return firms.map((f) => {
    const dms: DmContact[] = contacts
      .filter((c) => c.firm_id === f.id && c.email)
      .map((c) => ({
        email: c.email!,
        emailVerified: c.email_verified,
        unsubscribed: c.unsubscribed,
        suppression: supByEmail.get(c.email!) ?? null,
      }))
    const result = scoreFirm({
      handlesCustody: f.handles_custody,
      firmSizeBand: f.firm_size_band,
      limitedScope: null,
      decisionMakers: dms,
      state: f.state,
      county: f.county,
    })
    return { firmId: f.id, name: f.name, domain: f.domain, status: f.status, result }
  })
}

export async function writeScores(db: Db, scored: ScoredFirm[]) {
  const out = { written: 0, unchanged: 0, failed: [] as { firm: string; error: string }[] }
  for (const s of scored) {
    try {
      const breakdown = { version: s.result.version, disqualified_by: s.result.disqualified_by, lines: s.result.breakdown } as unknown as Json
      const ev = await appendEvent(db, {
        entity: 'firm',
        entityId: s.firmId,
        type: 'firm_scored',
        payload: { score: s.result.score, status: s.result.status, breakdown },
        idempotencyKey: `firm_scored:${s.firmId}:${stableHash(breakdown)}`,
      })
      if (!ev.inserted) {
        out.unchanged++
        continue
      }
      const { error } = await db.from('firms').update({ fit_score: s.result.score, score_breakdown: breakdown }).eq('id', s.firmId)
      if (error) throw new Error(error.message)
      if (SCORABLE.includes(s.status)) {
        await setFirmStatus(db, s.firmId, s.result.status, { reason: `scoring ${s.result.version}` })
      }
      out.written++
    } catch (err) {
      out.failed.push({ firm: s.name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

export function formatScore(s: ScoredFirm): string {
  const r = s.result
  const head = `${s.name} (${s.domain ?? 'no domain'}): ${r.score} -> ${r.status}${r.disqualified_by ? ` [${r.disqualified_by}]` : ''}`
  const lines = r.breakdown.map((l) => `    ${String(l.points).padStart(2)}/${l.max}  ${l.rule.padEnd(18)} ${l.basis}`)
  return [head, ...lines].join('\n')
}

const USAGE = `Usage: npm run score -- [--firm <domain|id|name>]... [--send]

Scores researched firms (SPEC §9 v1). Dry run by default: prints scores, writes nothing.

Options:
  --firm <ref>   Only this firm (repeatable): domain, id, or part of the name.
  --send         Store scores, breakdowns and status changes.
  -h, --help     Show this help.`

export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        firm: { type: 'string', multiple: true, default: [] },
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
  let config
  try {
    config = parseConfig(process.env)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }

  const db = createDb(config)
  let scored = await loadAndScore(db)
  if (values.firm.length) {
    const refs = values.firm.map((r) => r.toLowerCase())
    scored = scored.filter((s) => refs.some((r) => s.firmId === r || s.domain === r || s.name.toLowerCase().includes(r)))
    if (!scored.length) {
      console.error(`No scorable firm matches ${values.firm.join(', ')}`)
      return 2
    }
  }

  const counts = { qualified: 0, scored: 0, disqualified: 0 }
  for (const s of scored) counts[s.result.status]++
  console.log(
    `${values.send ? 'SCORING' : 'DRY RUN: nothing will be written.'} ${scored.length} firms: ` +
      `${counts.qualified} qualified, ${counts.scored} below threshold, ${counts.disqualified} disqualified.\n`,
  )
  for (const s of scored) console.log(formatScore(s) + '\n')
  if (!values.send) {
    if (scored.length) console.log('Re-run with --send to store these.')
    return 0
  }

  const log = createLogger({ level: config.LOG_LEVEL, base: { job: 'score' } })
  const out = await writeScores(db, scored)
  log.info('score_done', { written: out.written, unchanged: out.unchanged, failed: out.failed.length })
  console.log(`Written ${out.written}, unchanged ${out.unchanged}, failed ${out.failed.length}.`)
  for (const f of out.failed) console.log(`  failed ${f.firm}: ${f.error}`)
  return out.failed.length ? 1 : 0
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
