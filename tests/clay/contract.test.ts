// Contract tests: fixture payloads -> normalized values. If Clay's column
// output changes shape, add a fixture here first.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClayOutboundSchema,
  buildOutboundPayload,
  firmSizeBandFor,
  isDecisionMakerTitle,
  parseClayCallback,
  parseHeadcount,
} from '../../supabase/functions/_shared/clay-contract.ts'

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'clay')
export const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const FIRM_ID = '0b6f3c1e-8d2a-4c5b-9e7f-1a2b3c4d5e6f'

function ok(name: string) {
  const r = parseClayCallback(fixture(name))
  if (!r.ok) throw new Error(`${name} should parse: ${r.errors.join('; ')}`)
  return r.value
}

describe('outbound payload (Supabase -> Clay)', () => {
  it('matches the SPEC §7 example exactly', () => {
    const payload = buildOutboundPayload({ id: FIRM_ID, name: 'Smith & Rivera Family Law', domain: 'smithrivera.com', city: 'Red Bank', state: 'NJ' })
    expect(payload).toEqual(fixture('outbound.spec.json'))
    expect(Object.keys(payload)).toEqual(Object.keys(fixture('outbound.spec.json')))
  })

  it('refuses a firm without a domain and rejects extra keys', () => {
    expect(() => buildOutboundPayload({ id: FIRM_ID, name: 'X', domain: null, city: null, state: null })).toThrow(/no domain/)
    expect(ClayOutboundSchema.safeParse({ ...fixture('outbound.spec.json'), county: 'Monmouth' }).success).toBe(false)
  })
})

describe('callback payload (Clay -> clay-callback)', () => {
  it('parses the SPEC §7 example', () => {
    expect(ok('callback.spec.json')).toEqual({
      firmId: FIRM_ID,
      headcount: 6,
      firmSizeBand: 'small',
      custody: { answer: 'yes', handlesCustody: true, evidenceUrl: 'https://smithrivera.com/practice-areas/child-custody' },
      people: [
        {
          fullName: 'Jane Rivera',
          title: 'Managing Partner',
          email: 'jane@smithrivera.com',
          emailSource: 'provider_b',
          emailVerified: true,
          linkedinUrl: 'https://www.linkedin.com/in/jane-rivera-example',
          isDecisionMaker: true,
          decisionMakerSource: null,
        },
      ],
      droppedPeople: [],
    })
  })

  it('normalizes Clay-style strings: JSON-in-strings, "1,204", " Yes ", "TRUE", "", "null"', () => {
    const v = ok('callback.stringly.json')
    expect(v.headcount).toBe(1204)
    expect(v.firmSizeBand).toBe('large')
    expect(v.custody).toEqual({ answer: 'yes', handlesCustody: true, evidenceUrl: 'https://smithrivera.com/custody' })
    expect(v.people).toEqual([
      { fullName: 'Jane Rivera', title: 'Founding Partner', email: 'jane@smithrivera.com', emailSource: 'provider_a', emailVerified: true, linkedinUrl: null, isDecisionMaker: true, decisionMakerSource: null },
      { fullName: 'Tom Office', title: 'Office Manager', email: 'tom@smithrivera.com', emailSource: 'provider_b', emailVerified: false, linkedinUrl: null, isDecisionMaker: false, decisionMakerSource: null },
    ])
  })

  it('accepts a payload with only firm_id (custody unclear, nothing else)', () => {
    expect(ok('callback.minimal.json')).toEqual({
      firmId: FIRM_ID,
      headcount: null,
      firmSizeBand: null,
      custody: { answer: 'unclear', handlesCustody: null, evidenceUrl: null },
      people: [],
      droppedPeople: [],
    })
  })

  it('drops people without a usable email and dedupes by email, keeping the first', () => {
    const v = ok('callback.messy-people.json')
    expect(v.people.map((p) => [p.email, p.emailVerified, p.isDecisionMaker])).toEqual([
      ['jane@smithrivera.com', true, true],
      ['pat@smithrivera.com', false, false],
    ])
    expect(v.droppedPeople).toEqual([
      { index: 0, reason: 'no_email' },
      { index: 1, reason: 'invalid_email' },
      { index: 3, reason: 'duplicate_email' },
    ])
    expect(v.custody.handlesCustody).toBeNull()
  })

  describe('body built by docs/clay/table-setup.md (one decision-maker per firm, ADR 0009)', () => {
    it('accepts the one-item People JSON from the flat contact columns', () => {
      const v = ok('callback.checklist.json')
      expect(v.headcount).toBe(11)
      expect(v.firmSizeBand).toBe('mid')
      expect(v.people).toEqual([
        {
          fullName: 'Jane Rivera',
          title: 'Managing Partner',
          email: 'jane@smithrivera.com',
          emailSource: 'clay_waterfall',
          emailVerified: true,
          linkedinUrl: 'https://www.linkedin.com/in/jane-rivera-example',
          isDecisionMaker: true,
          decisionMakerSource: null,
        },
      ])
      expect(v.droppedPeople).toEqual([])
    })

    it('accepts "[]" when Find contacts found no one, and still enriches the firm', () => {
      const v = ok('callback.checklist-no-contact.json')
      expect(v.people).toEqual([])
      expect(v.droppedPeople).toEqual([])
      expect(v.headcount).toBe(2)
      expect(v.custody).toEqual({ answer: 'unclear', handlesCustody: null, evidenceUrl: null })
    })

    it('reports a found contact whose email the waterfall could not find as dropped', () => {
      const body = fixture('callback.checklist.json')
      body.people = JSON.stringify([
        { full_name: 'Jane Rivera', title: 'Managing Partner', email: null, email_source: null, email_verified: null, linkedin_url: 'https://www.linkedin.com/in/jane-rivera-example' },
      ])
      const r = parseClayCallback(body)
      expect(r.ok && r.value.people).toEqual([])
      expect(r.ok && r.value.droppedPeople).toEqual([{ index: 0, reason: 'no_email' }])
    })
  })

  it('stores the lower bound of a headcount range and derives the band (fixture)', () => {
    const v = ok('callback.headcount-range.json')
    expect(v.headcount).toBe(51)
    expect(v.firmSizeBand).toBe('large')
  })

  it('stores an exact numeric headcount and derives the band (fixture)', () => {
    const v = ok('callback.headcount-number.json')
    expect(v.headcount).toBe(4)
    expect(v.firmSizeBand).toBe('small')
  })

  it.each(['about six', '11-', '-50', '50-11', '11-50-200', '1.5', '6.0', '1,2', '12,34', 'N/A', '~10', '11 to 50', '+10'])(
    'still rejects malformed headcount %j',
    (headcount) => {
      const r = parseClayCallback({ firm_id: FIRM_ID, company: { headcount } })
      expect(r.ok).toBe(false)
    },
  )

  it.each([-1, 2.5, Number.NaN, 1e12])('rejects malformed numeric headcount %s', (headcount) => {
    expect(parseClayCallback({ firm_id: FIRM_ID, company: { headcount } }).ok).toBe(false)
  })

  it('reads a custody answer case-insensitively with whitespace trimmed (fixture)', () => {
    expect(ok('callback.custody-case.json').custody).toEqual({ answer: 'yes', handlesCustody: true, evidenceUrl: 'https://smithrivera.com/custody' })
  })

  it.each([
    ['yes', 'yes'], ['Yes', 'yes'], ['YES', 'yes'], ['  yes  ', 'yes'], ['\tYes\n', 'yes'],
    ['no', 'no'], ['No', 'no'], ['NO', 'no'], [' nO ', 'no'],
    ['unclear', 'unclear'], ['Unclear', 'unclear'], [' UNCLEAR ', 'unclear'],
    ['', 'unclear'], ['   ', 'unclear'],
  ])('custody answer %j -> %s', (answer, expected) => {
    const r = parseClayCallback({ firm_id: FIRM_ID, custody: { answer } })
    expect(r.ok && r.value.custody.answer).toBe(expected)
  })

  it.each(['Yes.', 'y', 'n', 'Yes, custody is listed', 'maybe', 'true', 'ye s'])('still rejects custody answer %j', (answer) => {
    expect(parseClayCallback({ firm_id: FIRM_ID, custody: { answer } }).ok).toBe(false)
  })

  describe('GTM Decision Makers payload (research_agent)', () => {
    it('accepts a body with no company or custody, and keeps both unknown', () => {
      const v = ok('callback.dm.json')
      expect(v.headcount).toBeNull()
      expect(v.firmSizeBand).toBeNull()
      expect(v.custody).toEqual({ answer: 'unclear', handlesCustody: null, evidenceUrl: null })
    })

    it('marks a research_agent person as the decision-maker even with a plain "Attorney" title', () => {
      expect(ok('callback.dm.json').people).toEqual([
        {
          fullName: 'Jennifer D. Whitfield',
          title: 'Attorney',
          email: 'jwhitfield@example-firm.com',
          emailSource: 'clay_waterfall',
          emailVerified: true,
          linkedinUrl: null,
          isDecisionMaker: true,
          decisionMakerSource: 'research_agent',
        },
      ])
    })

    it('reads the source case-insensitively and treats blank as none', () => {
      const body = fixture('callback.dm.json')
      body.people[0].decision_maker_source = ' Research_Agent '
      expect(parseClayCallback(body)).toMatchObject({ ok: true, value: { people: [{ decisionMakerSource: 'research_agent' }] } })
      body.people[0].decision_maker_source = ''
      body.people[0].title = 'Associate'
      expect(parseClayCallback(body)).toMatchObject({ ok: true, value: { people: [{ decisionMakerSource: null, isDecisionMaker: false }] } })
    })

    it('rejects an unknown source', () => {
      const body = fixture('callback.dm.json')
      body.people[0].decision_maker_source = 'guess'
      const r = parseClayCallback(body)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.join('\n')).toMatch(/people\.0\.decision_maker_source/)
    })
  })

  it('maps custody "No" to handles_custody = false', () => {
    expect(ok('callback.custody-no.json').custody).toMatchObject({ answer: 'no', handlesCustody: false })
  })

  it('rejects an invalid payload with a message per field', () => {
    const r = parseClayCallback(fixture('callback.invalid.json'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.firmId).toBeNull()
    expect(r.errors.join('\n')).toMatch(/firm_id/)
    expect(r.errors.join('\n')).toMatch(/company\.headcount: expected a headcount like 6, "1,204", "11-50" or "10,001\+", got "about six"/)
    expect(r.errors.join('\n')).toMatch(/custody\.answer/)
    expect(r.errors.join('\n')).toMatch(/people/)
  })

  it('keeps a valid firm_id on rejection so the event can be tied to the firm', () => {
    const r = parseClayCallback({ firm_id: FIRM_ID, company: { headcount: -3 } })
    expect(r).toMatchObject({ ok: false, firmId: FIRM_ID })
  })

  it('caps people per callback', () => {
    const people = Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@x.com` }))
    expect(parseClayCallback({ firm_id: FIRM_ID, people }).ok).toBe(false)
  })
})

describe('isDecisionMakerTitle', () => {
  it.each([
    ['Managing Partner', true], ['Partner', true], ['Founder', true], ['Founding Attorney', true],
    ['Owner', true], ['Principal', true], ['Shareholder', true], ['Solo Practitioner', true],
    ['Office Manager', false], ['Associate Attorney', false], ['Paralegal', false], ['Of Counsel', false], [null, false],
  ])('%s -> %s', (title, expected) => {
    expect(isDecisionMakerTitle(title)).toBe(expected)
  })
})

describe('parseHeadcount', () => {
  it.each([
    [6, { lower: 6, upper: 6, exact: true }],
    ['6', { lower: 6, upper: 6, exact: true }],
    ['1,204', { lower: 1204, upper: 1204, exact: true }],
    ['11-50', { lower: 11, upper: 50, exact: false }],
    ['51 - 200', { lower: 51, upper: 200, exact: false }],
    ['11\u201350', { lower: 11, upper: 50, exact: false }],
    ['1,001-5,000', { lower: 1001, upper: 5000, exact: false }],
    ['2-10 employees', { lower: 2, upper: 10, exact: false }],
    ['10,001+', { lower: 10001, upper: null, exact: false }],
    ['10001+ Employees', { lower: 10001, upper: null, exact: false }],
  ])('%j -> %j', (input, expected) => {
    expect(parseHeadcount(input)).toEqual(expected)
  })
})

describe('firmSizeBandFor', () => {
  it.each([
    ['1', 'solo'], ['1-1', 'solo'], ['2', 'small'], ['1-10', 'small'], ['2-10', 'small'], ['10', 'small'],
    ['11-50', 'mid'], ['50', 'mid'], ['51-200', 'large'], ['201-500', 'large'], ['10,001+', 'large'], ['0', null],
  ])('%s -> %s', (input, band) => {
    expect(firmSizeBandFor(parseHeadcount(input))).toBe(band)
  })

  it('gives no band without a headcount', () => {
    expect(firmSizeBandFor(null)).toBeNull()
  })
})
