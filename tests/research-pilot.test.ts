import { describe, expect, it } from 'vitest'
import { CASES, LIMITS, PRICE, evidenceCheck, gradeAnswer, nameMatches, normalizeName, routeFor, worstCaseFirmUsd, type FetchedPage, type ResearchOutput } from '../src/research/pilot.js'

const whitfield = CASES.find((c) => c.id === 'whitfield')!

const found = (name: string, evidence_url = 'https://x.com/', confirm = { currently_at_firm: true, practices_family_law: true }): ResearchOutput => ({
  decision_maker_status: 'found',
  decision_maker: { name, title: 'x', basis: 'founder', rule: 'most_senior_family_law', evidence_url, ...confirm },
  family_law_only: 'yes',
  handles_custody: 'yes',
  custody_evidence_url: null,
  attorney_count: null,
})

describe('research pilot grading', () => {
  it('normalizes names: case, Esq., middle initials, punctuation', () => {
    expect(normalizeName('Abigale M. Novak, Esq.')).toBe('abigale novak')
    expect(normalizeName('JENNIFER D. WHITFIELD')).toBe('jennifer whitfield')
  })

  it('matches the expected name or an alias, not a different person', () => {
    expect(nameMatches('Jennifer Diane Whitfield', whitfield.expected.person)).toBe(true)
    expect(nameMatches('Jennifer D. Whitfield, Esq.', whitfield.expected.person)).toBe(true)
    expect(nameMatches('Christian L. Novak', CASES.find((c) => c.id === 'harbor-point')!.expected.person)).toBe(false)
    expect(nameMatches(null, whitfield.expected.person)).toBe(false)
  })

  it('checks evidence: on the firm domain, actually fetched, name on the page', () => {
    const pages = new Map<string, FetchedPage>([['https://www.jdwhitfieldlaw-example.com/attorney/jennifer-d-whitfield/', { text: 'Jennifer D. Whitfield is the founding member...', title: 'Whitfield, Jennifer D.' }]])
    const out = found('Jennifer D. Whitfield', 'https://jdwhitfieldlaw-example.com/attorney/jennifer-d-whitfield')
    expect(evidenceCheck(out, 'jdwhitfieldlaw-example.com', pages)).toEqual({ onDomain: true, fetched: true, nameFoundIn: 'text', looksLikeBio: true })
    expect(evidenceCheck(found('Jennifer D. Whitfield', 'https://www.avvo.com/x'), 'jdwhitfieldlaw-example.com', pages)).toMatchObject({ onDomain: false, fetched: false })
  })
})

const byId = (id: string) => CASES.find((c) => c.id === id)!.expected

describe('research pilot labels and grading', () => {
  it('has all 10 M3 firms', () => {
    expect(CASES.map((c) => c.id)).toEqual(['ashford', 'harbor-point', 'whitfield', 'delacroix', 'okafor', 'lindqvist', 'pryor', 'vantner', 'thorne', 'marlowe'])
  })

  it('Ashford: founder is correct, Cassie is acceptable, Ashford III is neither', () => {
    expect(gradeAnswer(found('John P. Ashford Jr., Esq.'), byId('ashford'))).toEqual({ dm_correct: 1, dm_acceptable: 1 })
    expect(gradeAnswer(found('Cassie Carter, Esq.'), byId('ashford'))).toEqual({ dm_correct: 0, dm_acceptable: 1 })
    expect(gradeAnswer(found('John P. Ashford III, Esq.'), byId('ashford'))).toEqual({ dm_correct: 0, dm_acceptable: 0 })
  })

  it('Thorne: none_on_site is correct, the managing partner is only acceptable', () => {
    const none: ResearchOutput = { ...found('x'), decision_maker_status: 'none_on_site', decision_maker: null }
    expect(gradeAnswer(none, byId('thorne'))).toEqual({ dm_correct: 1, dm_acceptable: 1 })
    expect(gradeAnswer(found('Adrian Thorne'), byId('thorne'))).toEqual({ dm_correct: 0, dm_acceptable: 1 })
    expect(gradeAnswer(found('Someone Else'), byId('thorne'))).toEqual({ dm_correct: 0, dm_acceptable: 0 })
  })

  it('Lindqvist: the non-family-law managing partner is wrong', () => {
    expect(gradeAnswer(found('Mark F. Serrano'), byId('lindqvist'))).toEqual({ dm_correct: 0, dm_acceptable: 0 })
    expect(gradeAnswer(found('James J. Moretti'), byId('lindqvist'))).toEqual({ dm_correct: 1, dm_acceptable: 1 })
  })
})

describe('research pilot cost estimate', () => {
  it('counts every tool result as re-read by each later loop iteration', () => {
    // 2 results of 1000 tokens, base 100, loop limit 3 -> 300 base + 1000*2 + 1000*1 = 3300
    const { inputTokens } = worstCaseFirmUsd(
      { ...LIMITS, fetches: 1, searches: 1, maxContentTokensPerFetch: 1000, assumedSearchResultTokens: 1000, assumedBasePromptTokens: 100, serverLoopIterations: 3 },
      PRICE,
    )
    expect(inputTokens).toBe(3300)
  })

  it('worst case per firm uses the 10-iteration loop limit, not max_uses', () => {
    // 10 x 2500 base + search 15000 x 9 + fetches 4000 x (8+7+6+5) = 264,000 input tokens
    const w = worstCaseFirmUsd()
    expect(w.inputTokens).toBe(264_000)
    expect(w.usd).toBeCloseTo(0.264 + 0.01 + 0.01, 4)
  })

  it('covers the measured Thorne overshoot ($0.1744)', () => {
    expect(worstCaseFirmUsd().usd).toBeGreaterThan(0.1744)
  })
})

describe('evidence false alarms and routing', () => {
  const bio = 'https://www.delacroixlawgroup-example.com/attorneys/bari-z-delacroix/'

  it('accepts the name in the page title or URL slug when the capped text lacks it (Delacroix)', () => {
    const truncated = { text: 'Home | Practice Areas | Divorce | Custody | ... (navigation only)', title: '' }
    expect(evidenceCheck(found('Bari Z. Delacroix', bio), 'delacroixlawgroup-example.com', new Map([[bio, truncated]]))).toMatchObject({ nameFoundIn: 'slug', looksLikeBio: true })
    expect(
      evidenceCheck(found('Bari Z. Delacroix', 'https://www.delacroixlawgroup-example.com/team/'), 'delacroixlawgroup-example.com', new Map([['https://www.delacroixlawgroup-example.com/team/', { text: 'nav', title: 'Bari Delacroix | Founder' }]])),
    ).toMatchObject({ nameFoundIn: 'title', looksLikeBio: true })
  })

  it('routes a fully verified bio-page answer to send', () => {
    const pages = new Map([[bio, { text: 'Bari Z. Delacroix founded the firm...', title: 'Bari Z. Delacroix' }]])
    const out = found('Bari Z. Delacroix', bio)
    expect(routeFor(out, evidenceCheck(out, 'delacroixlawgroup-example.com', pages))).toEqual({ route: 'send', reasons: [] })
  })

  it('sends a deceased or non-family-law pick to needs_review (Lindqvist)', () => {
    const url = 'https://www.lindqvistlaw-example.com/attorneys/martin-m-lindqvist/'
    const pages = new Map([[url, { text: 'Martin M. Lindqvist (Deceased as of June 2020)', title: 'Martin M. Lindqvist' }]])
    const out = found('Martin M. Lindqvist', url, { currently_at_firm: false, practices_family_law: false })
    expect(routeFor(out, evidenceCheck(out, 'lindqvistlaw-example.com', pages))).toEqual({
      route: 'needs_review',
      reasons: ['not confirmed currently at firm', 'family-law practice not confirmed'],
    })
  })

  it('sends an answer citing a never-fetched page to needs_review (Thorne)', () => {
    const out = found('Harold Kessler', 'https://www.thornelegal-example.com/practices/family-law/')
    expect(routeFor(out, evidenceCheck(out, 'thornelegal-example.com', new Map()))).toMatchObject({ route: 'needs_review', reasons: ['evidence page was never fetched'] })
  })

  it('sends a non-bio evidence page to needs_review, and none_on_site to no_contact', () => {
    const url = 'https://www.thornelegal-example.com/practices/family-law/'
    const out = found('Harold Kessler', url)
    const ev = evidenceCheck(out, 'thornelegal-example.com', new Map([[url, { text: 'Harold Kessler handles family law', title: 'Family Law' }]]))
    expect(routeFor(out, ev)).toMatchObject({ route: 'needs_review', reasons: ['evidence is not a bio page'] })
    const none: ResearchOutput = { ...out, decision_maker_status: 'none_on_site', decision_maker: null }
    expect(routeFor(none, ev)).toEqual({ route: 'no_contact', reasons: ['none_on_site'] })
  })
})

