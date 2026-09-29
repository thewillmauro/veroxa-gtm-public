import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CsvHeaderError, domainFromWebsite, normalizeState, parseFirmsCsv } from '../src/seed/parse.js'
import { importFirms, planImport } from '../src/seed/import.js'
import { formatReport, main } from '../src/seed/cli.js'
import { isActiveTarget, normalizeNjCounty, targetPhaseOf } from '../src/lib/targets.js'
import type { Db } from '../src/lib/db.js'

const HEADER = 'name,website,city,county,state'

describe('targets', () => {
  it('normalizes NJ county spellings', () => {
    expect(normalizeNjCounty('Monmouth County')).toBe('Monmouth')
    expect(normalizeNjCounty('  ocean ')).toBe('Ocean')
    expect(normalizeNjCounty('CAPE   MAY county')).toBe('Cape May')
    expect(normalizeNjCounty('Monmoth')).toBeNull()
  })

  it('knows phase 1 and phase 2 counties', () => {
    expect(isActiveTarget('NJ', 'Monmouth')).toBe(true)
    expect(isActiveTarget('NJ', 'Ocean')).toBe(true)
    expect(isActiveTarget('NJ', 'Middlesex')).toBe(false)
    expect(targetPhaseOf('NJ', 'Mercer')).toBe('phase2')
    expect(targetPhaseOf('NJ', 'Bergen')).toBeNull()
    expect(targetPhaseOf('NY', 'Monmouth')).toBeNull()
  })
})

describe('domainFromWebsite', () => {
  it.each([
    ['https://www.SmithRivera.com/family-law?x=1', 'smithrivera.com'],
    ['smithrivera.com', 'smithrivera.com'],
    ['http://law.smith-rivera.co.uk:8080/', 'law.smith-rivera.co.uk'],
    ['WWW.EXAMPLE-LAW.COM.', 'example-law.com'],
  ])('%s -> %s', (input, expected) => {
    expect(domainFromWebsite(input)).toEqual({ domain: expected })
  })

  it.each(['https://www.avvo.com/attorneys/07701-nj-jane.html', 'facebook.com/smithlaw', 'sites.google.com/view/smithlaw', 'm.facebook.com/x'])(
    'rejects shared host %s',
    (input) => {
      expect(domainFromWebsite(input)).toMatchObject({ error: expect.stringMatching(/directory or social/) })
    },
  )

  it.each(['not a url', 'localhost', 'smith law.com', '-bad.com'])('rejects invalid %s', (input) => {
    expect(domainFromWebsite(input)).toMatchObject({ error: expect.stringMatching(/not a valid domain/) })
  })
})

describe('normalizeState', () => {
  it('accepts codes and the two spelled-out names', () => {
    expect(normalizeState('nj')).toBe('NJ')
    expect(normalizeState('New Jersey')).toBe('NJ')
    expect(normalizeState('Jersey')).toBeNull()
  })
})

describe('parseFirmsCsv', () => {
  it('parses, normalizes and warns on non-target counties', () => {
    const csv = [
      HEADER,
      'Smith & Rivera Family Law,https://www.smithrivera.com,Red Bank,Monmouth County,NJ',
      '"Doe, Roe LLP",doeroe.com,Toms River,ocean,new jersey',
      'Mid Firm,midfirm.com,New Brunswick,Middlesex,NJ',
      'North Firm,northfirm.com,Hackensack,Bergen,NJ',
      'No County,nocounty.com,,,NJ',
    ].join('\r\n')
    const r = parseFirmsCsv('﻿' + csv)
    expect(r.errors).toEqual([])
    expect(r.totalRows).toBe(5)
    expect(r.rows[0]).toEqual({ rowNumber: 2, name: 'Smith & Rivera Family Law', domain: 'smithrivera.com', city: 'Red Bank', county: 'Monmouth', state: 'NJ' })
    expect(r.rows[1]).toMatchObject({ name: 'Doe, Roe LLP', county: 'Ocean', state: 'NJ' })
    expect(r.rows[4]).toMatchObject({ city: null, county: null })
    expect(r.warnings.map((w) => [w.rowNumber, w.message])).toEqual([
      [4, 'Middlesex, NJ is a phase2 county, not scored yet'],
      [5, 'Bergen, NJ is outside the target counties'],
      [6, 'no county; firm will not earn target-county points'],
    ])
  })

  it('dedupes by normalized domain within the file, keeping the first', () => {
    const r = parseFirmsCsv([HEADER, 'A,smithrivera.com,,Monmouth,NJ', 'B,https://WWW.smithrivera.com/about,,Ocean,NJ'].join('\n'))
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.name).toBe('A')
    expect(r.duplicates).toEqual([{ rowNumber: 3, domain: 'smithrivera.com', firstRowNumber: 2 }])
  })

  it('reports every problem on a bad row with its line number', () => {
    const r = parseFirmsCsv([HEADER, ',avvo.com/x,,Monmoth,NJ', 'Ok,ok.com,,Monmoth,NJ', 'Ok2,ok2.com,,,Jersey'].join('\n'))
    expect(r.rows).toHaveLength(0)
    expect(r.errors).toEqual([
      { rowNumber: 2, message: 'name is required' },
      { rowNumber: 3, message: 'county "Monmoth" is not a New Jersey county' },
      { rowNumber: 4, message: 'state "Jersey" must be a 2-letter code' },
    ])
  })

  it('accepts any column order, case, and extra columns; skips blank lines', () => {
    const r = parseFirmsCsv(['State,Website,NAME,notes', 'NJ,a.com,A Firm,hello', '', ',,,'].join('\n'))
    expect(r.rows).toEqual([{ rowNumber: 2, name: 'A Firm', domain: 'a.com', city: null, county: null, state: 'NJ' }])
    expect(r.totalRows).toBe(1)
    expect(r.warnings[0]).toEqual({ rowNumber: 1, message: 'ignoring unknown column(s): notes' })
  })

  it('rejects files with missing or duplicate required columns', () => {
    expect(() => parseFirmsCsv('name,city\nA,B')).toThrow(CsvHeaderError)
    expect(() => parseFirmsCsv('name,website,state,website\n')).toThrow(/duplicate column/)
    expect(() => parseFirmsCsv('')).toThrow(/empty/)
  })

  it('treats the template as an empty, valid file', () => {
    const r = parseFirmsCsv(HEADER + '\n')
    expect(r).toMatchObject({ rows: [], errors: [], totalRows: 0 })
  })
})

// Fake db covering the two calls the importer makes.
function fakeDb(existing: string[], raceInserted: string[] = []) {
  const rpcCalls: any[] = []
  const db = {
    from: () => ({
      select: () => ({
        in: async (_col: string, domains: string[]) => ({ data: domains.filter((d) => existing.includes(d)).map((domain) => ({ domain })), error: null }),
      }),
    }),
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      const rows = args.p_firms
        .filter((f: any) => !existing.includes(f.domain) && !raceInserted.includes(f.domain))
        .map((f: any, i: number) => ({ id: `id-${i}`, domain: f.domain }))
      return { data: rows, error: null }
    },
  }
  return { db: db as unknown as Db, rpcCalls }
}

describe('planImport / importFirms', () => {
  const rows = parseFirmsCsv([HEADER, 'A,a.com,,Monmouth,NJ', 'B,b.com,,Ocean,NJ', 'C,c.com,,Ocean,NJ'].join('\n')).rows

  it('splits rows into new vs already in DB', async () => {
    const { db } = fakeDb(['b.com'])
    const plan = await planImport(db, rows)
    expect(plan.toInsert.map((r) => r.domain)).toEqual(['a.com', 'c.com'])
    expect(plan.existing.map((r) => r.domain)).toEqual(['b.com'])
  })

  it('sends source, import id and row numbers, and reports race skips', async () => {
    const { db, rpcCalls } = fakeDb([], ['c.com'])
    const out = await importFirms(db, rows, { source: 'manual_csv', importId: 'f.csv:abc:t' })
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0]).toMatchObject({ fn: 'import_firms', args: { p_source: 'manual_csv', p_import_id: 'f.csv:abc:t' } })
    expect(rpcCalls[0].args.p_firms[0]).toEqual({ name: 'A', domain: 'a.com', city: null, county: 'Monmouth', state: 'NJ', row_number: 2 })
    expect(out.inserted.map((r) => [r.domain, r.rowNumber])).toEqual([['a.com', 2], ['b.com', 3]])
    expect(out.skippedExisting.map((r) => r.domain)).toEqual(['c.com'])
  })

  it('refuses a malformed source', async () => {
    const { db } = fakeDb([])
    await expect(importFirms(db, rows, { source: 'Manual CSV', importId: 'x' })).rejects.toThrow(/Invalid source/)
  })
})

describe('cli', () => {
  let dir: string
  let out: string[]
  let err: string[]
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-'))
    out = []
    err = []
    vi.spyOn(console, 'log').mockImplementation((m) => void out.push(String(m)))
    vi.spyOn(console, 'error').mockImplementation((m) => void err.push(String(m)))
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  afterEach(() => {
    vi.restoreAllMocks()
    if (saved.url) process.env.SUPABASE_URL = saved.url
    if (saved.key) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key
  })

  const write = (body: string) => {
    const p = join(dir, 'firms.csv')
    writeFileSync(p, body)
    return p
  }

  it('dry run without DB config validates the file and exits 0', async () => {
    const code = await main([write([HEADER, 'A,a.com,Red Bank,Monmouth,NJ'].join('\n')), '--dry-run'])
    expect(code).toBe(0)
    expect(out.join('\n')).toMatch(/DRY RUN: nothing will be written/)
    expect(out.join('\n')).toMatch(/database check\s+skipped/)
    expect(err.join('\n')).toMatch(/Database check skipped\. Invalid environment config:[\s\S]*SUPABASE_URL/)
  })

  it('dry run exits 1 when rows are invalid', async () => {
    expect(await main([write([HEADER, 'A,avvo.com,,,NJ'].join('\n')), '--dry-run'])).toBe(1)
    expect(out.join('\n')).toMatch(/row 2: .*directory or social/)
  })

  it('a real import without DB config exits 2 and writes nothing', async () => {
    expect(await main([write([HEADER, 'A,a.com,,,NJ'].join('\n'))])).toBe(2)
    expect(err.join('\n')).toMatch(/SUPABASE_URL/)
  })

  it('rejects bad usage', async () => {
    expect(await main([])).toBe(2)
    expect(await main([write(HEADER), '--source', 'Bad Source'])).toBe(2)
    expect(await main([join(dir, 'missing.csv')])).toBe(2)
    expect(await main([write('foo,bar\n1,2')])).toBe(2)
  })

  it('formatReport lists what a dry run would insert', () => {
    const parsed = parseFirmsCsv([HEADER, 'A,a.com,Red Bank,Monmouth,NJ'].join('\n'))
    const text = formatReport({ file: 'f.csv', source: 'manual_csv', dryRun: true, parsed, plan: { toInsert: parsed.rows, existing: [] } })
    expect(text).toMatch(/would insert\s+1/)
    expect(text).toMatch(/row 2: A \| a\.com \| Red Bank, Monmouth, NJ/)
  })
})
