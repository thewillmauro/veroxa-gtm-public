// npm run research:store -- <runDir>... [--dry-run]
//
// Writes saved research-pilot results (evals/runs/<run>/) to the database,
// without calling the model again:
//   - one `research` row per result (model, prompt_version, output, evidence)
//   - firm status -> researched (status_changed event via setFirmStatus)
//   - a `research_stored` event with the route and reasons, idempotent per
//     firm + run + model, so re-running this is a no-op
//
// Only pilot-v2 results are stored: v1 results predate the bio-page
// confirmation fields and can't be routed. Run dirs are processed in the
// order given; the research table is append-only, so the last row per firm
// is the current one.

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { getDb } from '../lib/db.js'
import { appendEvent, setFirmStatus } from '../lib/events.js'
import type { Json } from '../lib/database.types.js'
import { CASES, PROMPT_VERSION } from './pilot.js'

interface ResultRow {
  id: string
  model: string
  prompt_version?: string
  output: Json
  expected: string
  pages_fetched: string[]
  name_found_in: string | null
  route: 'send' | 'needs_review' | 'no_contact'
  route_reasons: string[]
  cost_usd: number
  grade: Record<string, number>
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { 'dry-run': { type: 'boolean', default: false } } })
  if (!positionals.length) {
    console.error('Usage: npm run research:store -- <runDir>... [--dry-run]')
    return 2
  }
  const db = getDb()
  const { data: firms, error } = await db.from('firms').select('id, domain, status').in('domain', CASES.map((c) => c.domain))
  if (error) throw new Error(error.message)
  const firmByDomain = new Map(firms.map((f) => [f.domain, f]))

  for (const dir of positionals) {
    const run = basename(dir)
    const rows = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ResultRow)
    for (const r of rows) {
      if (r.prompt_version !== PROMPT_VERSION) {
        console.log(`skip ${run}/${r.id}: prompt ${r.prompt_version ?? 'v1'} (only ${PROMPT_VERSION} is stored)`)
        continue
      }
      const c = CASES.find((x) => x.id === r.id)
      const firm = c && firmByDomain.get(c.domain)
      if (!firm) throw new Error(`No firm in the database for case ${r.id}`)
      const key = `research_stored:${firm.id}:${run}:${r.model}`
      const { data: seen } = await db.from('pipeline_events').select('id').eq('idempotency_key', key).maybeSingle()
      if (seen) {
        console.log(`already stored ${run}/${r.id}`)
        continue
      }
      const evidence = { pages_fetched: r.pages_fetched, name_found_in: r.name_found_in, route: r.route, route_reasons: r.route_reasons, run, cost_usd: r.cost_usd }
      if (values['dry-run']) {
        console.log(`would store ${r.id} (${r.model}): ${r.route}${r.route_reasons.length ? ` [${r.route_reasons.join('; ')}]` : ''}; status ${firm.status} -> researched`)
        continue
      }
      const { data: research, error: insErr } = await db
        .from('research')
        .insert({ firm_id: firm.id, model: r.model, prompt_version: r.prompt_version, output: r.output, evidence: evidence as Json })
        .select('id')
        .single()
      if (insErr) throw new Error(`research insert for ${r.id}: ${insErr.message}`)
      await setFirmStatus(db, firm.id, 'researched', { reason: 'research_pilot', payload: { research_id: research.id, route: r.route, reasons: r.route_reasons } })
      await appendEvent(db, {
        entity: 'firm',
        entityId: firm.id,
        type: 'research_stored',
        payload: { research_id: research.id, model: r.model, prompt_version: r.prompt_version ?? null, route: r.route, reasons: r.route_reasons, run },
        idempotencyKey: key,
      })
      console.log(`stored ${r.id} (${r.model}): ${r.route}${r.route_reasons.length ? ` [${r.route_reasons.join('; ')}]` : ''}`)
    }
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
