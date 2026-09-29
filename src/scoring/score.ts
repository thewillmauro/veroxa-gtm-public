// Scoring v1 (SPEC §9): a pure function of what we already know about a firm.
// Every rule appears in the breakdown, including the ones that scored 0 and
// why, so a reader can see the full reasoning, not just the total.

import { isActiveTarget } from '../lib/targets.js'

export const SCORING_VERSION = 'v1'
export const QUALIFY_THRESHOLD = 60

export type Rule = 'handles_custody' | 'firm_size' | 'limited_scope' | 'verified_dm_email' | 'target_county'

export interface BreakdownLine {
  rule: Rule
  points: number
  max: number
  /** Why this rule scored what it did, in plain words. */
  basis: string
}

export interface DmContact {
  email: string
  emailVerified: boolean | null
  unsubscribed: boolean
  /** From `suppressions`; a `hold:` source means held, not suppressed for good. */
  suppression: { reason: string; source: string } | null
}

export interface ScoreInput {
  handlesCustody: boolean | null
  firmSizeBand: string | null
  /** No research field carries this yet; `null` scores 0 as unknown. */
  limitedScope: 'yes' | 'no' | 'unclear' | null
  decisionMakers: DmContact[]
  state: string | null
  county: string | null
}

export type ScoreStatus = 'qualified' | 'scored' | 'disqualified'

export interface ScoreResult {
  version: typeof SCORING_VERSION
  score: number
  status: ScoreStatus
  disqualified_by: 'handles_custody_no' | null
  breakdown: BreakdownLine[]
}

export function scoreHandlesCustody(v: boolean | null): BreakdownLine {
  const line = { rule: 'handles_custody' as const, max: 40 }
  if (v === true) return { ...line, points: 40, basis: 'handles custody: yes' }
  if (v === false) return { ...line, points: 0, basis: 'handles custody: no (disqualifies)' }
  return { ...line, points: 0, basis: 'handles custody: unknown' }
}

export function scoreFirmSize(band: string | null): BreakdownLine {
  const line = { rule: 'firm_size' as const, max: 20 }
  if (band === 'solo' || band === 'small') return { ...line, points: 20, basis: `size band: ${band}` }
  return { ...line, points: 0, basis: band ? `size band: ${band}` : 'size band: unknown' }
}

export function scoreLimitedScope(v: ScoreInput['limitedScope']): BreakdownLine {
  const line = { rule: 'limited_scope' as const, max: 15 }
  if (v === 'yes') return { ...line, points: 15, basis: 'offers limited-scope / unbundled services' }
  if (v === null) return { ...line, points: 0, basis: 'limited scope: unknown (not researched yet)' }
  return { ...line, points: 0, basis: `limited scope: ${v}` }
}

/** A decision-maker email counts only if it's verified and we could actually use it. */
export function usableDmEmail(dm: DmContact): { ok: true } | { ok: false; why: string } {
  if (!dm.emailVerified) return { ok: false, why: `${dm.email} not verified` }
  if (dm.unsubscribed) return { ok: false, why: `${dm.email} unsubscribed` }
  if (dm.suppression) {
    const held = dm.suppression.source.startsWith('hold:')
    return { ok: false, why: `${dm.email} ${held ? 'held' : 'suppressed'} (${dm.suppression.source})` }
  }
  return { ok: true }
}

export function scoreVerifiedDmEmail(dms: DmContact[]): BreakdownLine {
  const line = { rule: 'verified_dm_email' as const, max: 15 }
  if (!dms.length) return { ...line, points: 0, basis: 'no decision-maker contact' }
  const usable = dms.find((d) => usableDmEmail(d).ok)
  if (usable) return { ...line, points: 15, basis: `verified: ${usable.email}` }
  const whys = dms.map((d) => usableDmEmail(d)).flatMap((r) => (r.ok ? [] : [r.why]))
  return { ...line, points: 0, basis: whys.join('; ') }
}

export function scoreTargetCounty(state: string | null, county: string | null): BreakdownLine {
  const line = { rule: 'target_county' as const, max: 10 }
  const where = county && state ? `${county}, ${state}` : 'unknown county'
  if (isActiveTarget(state, county)) return { ...line, points: 10, basis: `${where} (active target)` }
  return { ...line, points: 0, basis: `${where} (not an active target)` }
}

export function scoreFirm(input: ScoreInput): ScoreResult {
  const breakdown = [
    scoreHandlesCustody(input.handlesCustody),
    scoreFirmSize(input.firmSizeBand),
    scoreLimitedScope(input.limitedScope),
    scoreVerifiedDmEmail(input.decisionMakers),
    scoreTargetCounty(input.state, input.county),
  ]
  const score = breakdown.reduce((sum, l) => sum + l.points, 0)
  if (input.handlesCustody === false) {
    return { version: SCORING_VERSION, score, status: 'disqualified', disqualified_by: 'handles_custody_no', breakdown }
  }
  return {
    version: SCORING_VERSION,
    score,
    status: score >= QUALIFY_THRESHOLD ? 'qualified' : 'scored',
    disqualified_by: null,
    breakdown,
  }
}
