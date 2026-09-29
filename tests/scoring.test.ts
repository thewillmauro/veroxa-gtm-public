import { describe, expect, it } from 'vitest'
import {
  QUALIFY_THRESHOLD,
  scoreFirm,
  scoreFirmSize,
  scoreHandlesCustody,
  scoreLimitedScope,
  scoreTargetCounty,
  scoreVerifiedDmEmail,
  type DmContact,
  type ScoreInput,
} from '../src/scoring/score.js'

const dm = (over: Partial<DmContact> = {}): DmContact => ({
  email: 'jane@smithrivera.com',
  emailVerified: true,
  unsubscribed: false,
  suppression: null,
  ...over,
})

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  handlesCustody: true,
  firmSizeBand: 'small',
  limitedScope: null,
  decisionMakers: [dm()],
  state: 'NJ',
  county: 'Monmouth',
  ...over,
})

describe('rule: handles custody (+40, no disqualifies)', () => {
  it('yes scores 40', () => expect(scoreHandlesCustody(true).points).toBe(40))
  it('no scores 0', () => expect(scoreHandlesCustody(false)).toMatchObject({ points: 0, basis: expect.stringMatching(/disqualifies/) }))
  it('unknown scores 0', () => expect(scoreHandlesCustody(null)).toMatchObject({ points: 0, basis: 'handles custody: unknown' }))
})

describe('rule: firm size solo/small (+20)', () => {
  it.each(['solo', 'small'])('%s scores 20', (b) => expect(scoreFirmSize(b).points).toBe(20))
  it.each(['mid', 'large'])('%s scores 0', (b) => expect(scoreFirmSize(b).points).toBe(0))
  it('unknown scores 0', () => expect(scoreFirmSize(null)).toMatchObject({ points: 0, basis: 'size band: unknown' }))
})

describe('rule: limited scope (+15)', () => {
  it('yes scores 15', () => expect(scoreLimitedScope('yes').points).toBe(15))
  it('no and unclear score 0', () => {
    expect(scoreLimitedScope('no').points).toBe(0)
    expect(scoreLimitedScope('unclear').points).toBe(0)
  })
  it('not researched scores 0 and says so', () =>
    expect(scoreLimitedScope(null)).toMatchObject({ points: 0, basis: expect.stringMatching(/not researched/) }))
})

describe('rule: verified decision-maker email (+15)', () => {
  it('a verified, usable email scores 15', () => expect(scoreVerifiedDmEmail([dm()]).points).toBe(15))
  it('no decision-maker scores 0', () => expect(scoreVerifiedDmEmail([])).toMatchObject({ points: 0, basis: 'no decision-maker contact' }))
  it('unverified scores 0', () => expect(scoreVerifiedDmEmail([dm({ emailVerified: false })]).points).toBe(0))
  it('unsubscribed scores 0', () => expect(scoreVerifiedDmEmail([dm({ unsubscribed: true })]).points).toBe(0))
  it('suppressed scores 0', () =>
    expect(scoreVerifiedDmEmail([dm({ suppression: { reason: 'manual', source: 'wrong_email:domain_mismatch' } })])).toMatchObject({
      points: 0,
      basis: expect.stringMatching(/suppressed/),
    }))
  it('held scores 0 and says held', () =>
    expect(scoreVerifiedDmEmail([dm({ suppression: { reason: 'manual', source: 'hold:confirm_jr_vs_iii' } })])).toMatchObject({
      points: 0,
      basis: expect.stringMatching(/held/),
    }))
  it('one usable email among several is enough', () =>
    expect(scoreVerifiedDmEmail([dm({ email: 'x@smithrivera.com', emailVerified: false }), dm()]).points).toBe(15))
})

describe('rule: target county (+10)', () => {
  it('an active phase-1 county scores 10', () => expect(scoreTargetCounty('NJ', 'Ocean').points).toBe(10))
  it('a phase-2 county scores 0 while phase 1 is active', () => expect(scoreTargetCounty('NJ', 'Mercer').points).toBe(0))
  it('unknown county scores 0', () => expect(scoreTargetCounty('NJ', null).points).toBe(0))
})

describe('scoreFirm', () => {
  it('sums every rule and keeps all five lines in the breakdown', () => {
    const r = scoreFirm(input())
    expect(r.score).toBe(85)
    expect(r.breakdown.map((l) => l.rule)).toEqual(['handles_custody', 'firm_size', 'limited_scope', 'verified_dm_email', 'target_county'])
  })

  it(`qualifies at exactly ${QUALIFY_THRESHOLD}`, () => {
    const r = scoreFirm(input({ decisionMakers: [], county: null }))
    expect(r).toMatchObject({ score: 60, status: 'qualified' })
  })

  it('is scored (not qualified) below the threshold', () => {
    const r = scoreFirm(input({ firmSizeBand: 'large', decisionMakers: [] }))
    expect(r).toMatchObject({ score: 50, status: 'scored', disqualified_by: null })
  })

  it('handles custody = no disqualifies whatever the other points', () => {
    const r = scoreFirm(input({ handlesCustody: false, limitedScope: 'yes' }))
    expect(r).toMatchObject({ status: 'disqualified', disqualified_by: 'handles_custody_no' })
  })

  it('unknown custody does not disqualify', () => {
    expect(scoreFirm(input({ handlesCustody: null })).status).toBe('scored')
  })
})
