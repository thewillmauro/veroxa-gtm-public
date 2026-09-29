// npm run seed -- <file.csv> [--dry-run] [--source manual_csv] [--skip-invalid]
//
// Exit codes: 0 ok, 1 invalid rows (nothing written), 2 usage/config error.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { parseConfig } from '../lib/config.js'
import { createDb } from '../lib/db.js'
import { createLogger } from '../lib/logger.js'
import { CsvHeaderError, parseFirmsCsv, type ParseResult } from './parse.js'
import { DEFAULT_SOURCE, SOURCE_RE, importFirms, planImport, type ImportPlan } from './import.js'

const USAGE = `Usage: npm run seed -- <file.csv> [options]

Imports firms from a hand-built CSV (columns: name, website, city, county, state).
Template: data/seed/firms.template.csv

Options:
  --dry-run        Validate and show what would be imported. Writes nothing.
  --source <tag>   Value for firms.source (default: ${DEFAULT_SOURCE}).
                   Lowercase letters, digits, _ : . - (e.g. manual_csv:referrals)
  --skip-invalid   Import the valid rows even if some rows are invalid.
  -h, --help       Show this help.`

export function formatReport(opts: {
  file: string
  source: string
  dryRun: boolean
  parsed: ParseResult
  plan: ImportPlan | null
  inserted?: number
  skippedAtInsert?: number
}): string {
  const { parsed, plan } = opts
  const lines: string[] = []
  lines.push(`${opts.dryRun ? 'DRY RUN: nothing will be written' : 'IMPORT'}  file=${opts.file}  source=${opts.source}`)
  lines.push('')
  lines.push(`  rows read                 ${parsed.totalRows}`)
  lines.push(`  valid                     ${parsed.rows.length}`)
  lines.push(`  invalid                   ${parsed.errors.length}`)
  lines.push(`  duplicate in file         ${parsed.duplicates.length}`)
  if (plan) {
    lines.push(`  already in database       ${plan.existing.length}`)
    lines.push(`  ${opts.dryRun ? 'would insert' : 'to insert   '}              ${plan.toInsert.length}`)
  } else {
    lines.push('  database check            skipped (config not available, see below)')
  }
  if (opts.inserted !== undefined) lines.push(`  inserted                  ${opts.inserted}`)
  if (opts.skippedAtInsert) lines.push(`  skipped (created meanwhile) ${opts.skippedAtInsert}`)

  if (parsed.errors.length) {
    lines.push('', 'Invalid rows:')
    for (const e of parsed.errors) lines.push(`  row ${e.rowNumber}: ${e.message}`)
  }
  if (parsed.duplicates.length) {
    lines.push('', 'Duplicates in file (first occurrence kept):')
    for (const d of parsed.duplicates) lines.push(`  row ${d.rowNumber}: ${d.domain} (same as row ${d.firstRowNumber})`)
  }
  if (plan?.existing.length) {
    lines.push('', 'Already in database (left unchanged):')
    for (const r of plan.existing) lines.push(`  row ${r.rowNumber}: ${r.domain}`)
  }
  if (parsed.warnings.length) {
    lines.push('', 'Warnings:')
    for (const w of parsed.warnings) lines.push(`  row ${w.rowNumber}: ${w.message}`)
  }
  if (opts.dryRun && plan?.toInsert.length) {
    lines.push('', 'Would insert:')
    for (const r of plan.toInsert) {
      lines.push(`  row ${r.rowNumber}: ${r.name} | ${r.domain} | ${[r.city, r.county, r.state].filter(Boolean).join(', ')}`)
    }
  }
  return lines.join('\n')
}

export async function main(argv: string[]): Promise<number> {
  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        source: { type: 'string', default: DEFAULT_SOURCE },
        'skip-invalid': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }

  const { values, positionals } = args
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const file = positionals[0]
  if (!file || positionals.length > 1) {
    console.error(USAGE)
    return 2
  }
  const source = values.source
  if (!SOURCE_RE.test(source)) {
    console.error(`Invalid --source "${source}". Use lowercase letters, digits, _ : . -`)
    return 2
  }
  const dryRun = values['dry-run']

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`Cannot read ${file}: ${(e as Error).message}`)
    return 2
  }

  let parsed: ParseResult
  try {
    parsed = parseFirmsCsv(text)
  } catch (e) {
    if (e instanceof CsvHeaderError) {
      console.error(e.message)
      return 2
    }
    throw e
  }

  // Config: a dry run can still validate the file without DB access.
  let db = null
  let dbSkipReason: string | null = null
  try {
    const config = parseConfig(process.env)
    db = createDb(config)
  } catch (e) {
    if (!dryRun) {
      console.error((e as Error).message)
      return 2
    }
    dbSkipReason = (e as Error).message
  }

  const plan = db ? await planImport(db, parsed.rows) : null
  const hasInvalid = parsed.errors.length > 0

  if (dryRun || !db) {
    console.log(formatReport({ file, source, dryRun: true, parsed, plan }))
    if (dbSkipReason) console.error(`\nDatabase check skipped. ${dbSkipReason}`)
    return hasInvalid ? 1 : 0
  }

  if (hasInvalid && !values['skip-invalid']) {
    console.log(formatReport({ file, source, dryRun: false, parsed, plan }))
    console.error('\nNothing imported: fix the invalid rows, or re-run with --skip-invalid.')
    return 1
  }

  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  const importId = `${basename(file)}:${hash}:${new Date().toISOString()}`
  const log = createLogger({ base: { job: 'seed', import_id: importId } })

  const outcome = await importFirms(db, plan!.toInsert, { source, importId })
  log.info('seed_import_complete', {
    source,
    rows_read: parsed.totalRows,
    inserted: outcome.inserted.length,
    invalid: parsed.errors.length,
    duplicates_in_file: parsed.duplicates.length,
    already_existing: plan!.existing.length + outcome.skippedExisting.length,
  })
  console.log(
    formatReport({
      file,
      source,
      dryRun: false,
      parsed,
      plan,
      inserted: outcome.inserted.length,
      skippedAtInsert: outcome.skippedExisting.length,
    }),
  )
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
