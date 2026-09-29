// npm run review                                  interactive: walk pending needs_review firms
// npm run review -- --list                        show every needs_review firm and its decision
// npm run review -- --approve <firm> [--note ..]  approve one (firm = domain, id, or name fragment)
// npm run review -- --reject <firm> --note ..     reject one
//
// Every decision is a `research_reviewed` event in pipeline_events, tied to
// the research row it judges. A newer research run needs a fresh review.

import { userInfo } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { getDb, type Db } from '../lib/db.js'
import { appendEvent } from '../lib/events.js'
import { findFirm, loadFirmResearch, type FirmResearch, type ReviewDecision } from './delivery.js'

export function describe(r: FirmResearch): string {
  const lines = [
    `${r.firmName} (${r.domain})`,
    `  decision-maker: ${r.dm ? `${r.dm.name}, ${r.dm.title}` : '(none)'}`,
    `  evidence:       ${r.dm?.evidence_url ?? '-'}`,
    `  reasons:        ${r.reasons.join('; ') || '-'}`,
    `  model:          ${r.model}`,
  ]
  if (r.review) lines.push(`  decision:       ${r.review.decision}${r.review.note ? ` (${r.review.note})` : ''} at ${r.review.at}`)
  return lines.join('\n')
}

export async function recordDecision(db: Db, r: FirmResearch, decision: ReviewDecision, note: string | null): Promise<void> {
  if (decision === 'approved' && !r.dm) throw new Error(`${r.firmName} has no decision-maker to approve`)
  await appendEvent(db, {
    entity: 'firm',
    entityId: r.firmId,
    type: 'research_reviewed',
    payload: {
      research_id: r.researchId,
      decision,
      note,
      reviewer: userInfo().username,
      decision_maker: r.dm ? { ...r.dm } : null,
      route_at_review: r.route,
      reasons: r.reasons,
    },
  })
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      list: { type: 'boolean', default: false },
      approve: { type: 'string' },
      reject: { type: 'string' },
      note: { type: 'string' },
    },
  })
  const db = getDb()
  const all = await loadFirmResearch(db)
  const reviewable = all.filter((r) => r.route === 'needs_review')

  if (values.approve || values.reject) {
    const ref = (values.approve ?? values.reject)!
    const decision: ReviewDecision = values.approve ? 'approved' : 'rejected'
    if (values.approve && values.reject) {
      console.error('Use --approve or --reject, not both.')
      return 2
    }
    if (decision === 'rejected' && !values.note) {
      console.error('A rejection needs --note "why", so the audit log says what was wrong.')
      return 2
    }
    const found = findFirm(reviewable, ref)
    if ('error' in found) {
      console.error(`${found.error}. Reviewable: ${reviewable.map((r) => r.domain).join(', ') || '(none)'}`)
      return 2
    }
    await recordDecision(db, found, decision, values.note ?? null)
    console.log(`${decision}: ${found.firmName}${found.dm ? ` -> ${found.dm.name}` : ''}`)
    return 0
  }

  if (values.list) {
    if (!reviewable.length) console.log('No firms in needs_review.')
    for (const r of reviewable) console.log(`\n${describe(r)}`)
    return 0
  }

  const pending = reviewable.filter((r) => !r.review)
  if (!pending.length) {
    console.log('Nothing pending review. (--list shows decided ones.)')
    return 0
  }
  if (!process.stdin.isTTY) {
    for (const r of pending) console.log(`\n${describe(r)}`)
    console.log('\nNot an interactive terminal. Decide with:\n  npm run review -- --approve <domain> [--note "..."]\n  npm run review -- --reject <domain> --note "..."')
    return 0
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (const r of pending) {
      console.log(`\n${describe(r)}`)
      if (r.dm) console.log(`  open the evidence page and check it before approving`)
      let answer = ''
      while (!['a', 'r', 's', 'q'].includes(answer)) {
        answer = (await rl.question(r.dm ? '  [a]pprove, [r]eject, [s]kip, [q]uit: ' : '  [r]eject, [s]kip, [q]uit: ')).trim().toLowerCase()
        if (answer === 'a' && !r.dm) answer = ''
      }
      if (answer === 'q') break
      if (answer === 's') continue
      const decision: ReviewDecision = answer === 'a' ? 'approved' : 'rejected'
      let note = (await rl.question(`  note${decision === 'rejected' ? ' (required)' : ' (optional)'}: `)).trim()
      while (decision === 'rejected' && !note) note = (await rl.question('  note (required): ')).trim()
      await recordDecision(db, r, decision, note || null)
      console.log(`  ${decision}.`)
    }
  } finally {
    rl.close()
  }
  return 0
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
