import { describe, expect, it, vi } from 'vitest'
import { eligibility, findFirm, type FirmResearch } from '../src/research/delivery.js'
import { buildDmPayload, main, planDmSend, waterfallName } from '../src/clay/send-dm.js'

const firm = (over: Partial<FirmResearch> = {}): FirmResearch => ({
  firmId: '07d5cda2-c944-4c10-b4e2-5a38516e3f13',
  firmName: 'Ashford Bell & Carter',
  domain: 'ashfordbell-example.com',
  researchId: '11111111-1111-4111-8111-111111111111',
  model: 'claude-haiku-4-5-20251001',
  route: 'send',
  reasons: [],
  dm: { name: 'John P. Ashford Jr., Esq.', title: 'Founder', evidence_url: 'https://www.ashfordbell-example.com/attorneys/john-p-ashford-jr-esq/' },
  review: null,
  sentAt: null,
  ...over,
})

describe('eligibility', () => {
  it('delivers send-route firms', () => {
    expect(eligibility(firm())).toEqual({ deliver: true })
  })

  it('holds needs_review until approved, and never delivers a rejection', () => {
    const nr = firm({ route: 'needs_review', reasons: ['evidence page was never fetched'] })
    expect(eligibility(nr)).toEqual({ deliver: false, why: 'needs review: evidence page was never fetched' })
    expect(eligibility({ ...nr, review: { decision: 'approved', note: null, at: 't' } })).toEqual({ deliver: true })
    expect(eligibility({ ...nr, review: { decision: 'rejected', note: 'wrong partner', at: 't' } })).toEqual({ deliver: false, why: 'rejected in review: wrong partner' })
    expect(eligibility(firm({ review: { decision: 'rejected', note: null, at: 't' } }))).toMatchObject({ deliver: false })
  })

  it('skips no_contact and anything already sent', () => {
    expect(eligibility(firm({ route: 'no_contact', dm: null }))).toEqual({ deliver: false, why: 'no decision-maker named on site' })
    expect(eligibility(firm({ sentAt: '2026-09-28T19:00:00Z' }))).toEqual({ deliver: false, why: 'already sent 2026-09-28T19:00:00Z' })
  })
})

describe('findFirm', () => {
  const all = [firm(), firm({ firmId: '29b8b6de-3068-47da-9931-38aaf397293c', firmName: 'Jennifer D. Whitfield LLC', domain: 'jdwhitfieldlaw-example.com' })]

  it('matches by domain, id, or a unique name fragment', () => {
    expect(findFirm(all, 'jdwhitfieldlaw-example.com')).toMatchObject({ firmName: 'Jennifer D. Whitfield LLC' })
    expect(findFirm(all, '07d5cda2-c944-4c10-b4e2-5a38516e3f13')).toMatchObject({ domain: 'ashfordbell-example.com' })
    expect(findFirm(all, 'ashford')).toMatchObject({ domain: 'ashfordbell-example.com' })
  })

  it('refuses ambiguous or unknown references', () => {
    expect(findFirm(all, '.com')).toMatchObject({ error: expect.stringMatching(/matches 2 firms/) })
    expect(findFirm(all, 'nobody')).toMatchObject({ error: expect.stringMatching(/No researched firm/) })
  })
})

describe('clay:send-dm', () => {
  it('builds exactly the six-field payload', () => {
    expect(buildDmPayload(firm())).toEqual({
      firm_id: '07d5cda2-c944-4c10-b4e2-5a38516e3f13',
      firm_name: 'Ashford Bell & Carter',
      domain: 'ashfordbell-example.com',
      dm_name: 'John P. Ashford Jr.',
      dm_title: 'Founder',
      evidence_url: 'https://www.ashfordbell-example.com/attorneys/john-p-ashford-jr-esq/',
    })
  })

  it('strips Esq. from the waterfall name but keeps Jr. and III', () => {
    expect(waterfallName('Abigale M. Novak, Esq.')).toBe('Abigale M. Novak')
    expect(waterfallName('John P. Ashford Jr., Esq.')).toBe('John P. Ashford Jr.')
    expect(waterfallName('John P. Ashford III, Esquire')).toBe('John P. Ashford III')
    expect(waterfallName('Christine N. Okafor')).toBe('Christine N. Okafor')
  })

  it('plans only deliverable firms', () => {
    const plan = planDmSend([firm(), firm({ route: 'needs_review', reasons: ['x'] }), firm({ route: 'no_contact', dm: null })])
    expect(plan.send).toHaveLength(1)
    expect(plan.skip.map((s) => s.why)).toEqual(['needs review: x', 'no decision-maker named on site'])
  })

  it('refuses --send without the DM webhook, to a non-Clay host, or to the GTM Firms webhook', async () => {
    const saved = { ...process.env }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
    delete process.env.CLAY_DM_WEBHOOK_URL
    expect(await main(['--send'])).toBe(2)
    process.env.CLAY_DM_WEBHOOK_URL = 'https://evil.example.com/hook'
    expect(await main(['--send'])).toBe(2)
    process.env.CLAY_DM_WEBHOOK_URL = 'https://api.clay.com/v3/sources/webhook/firms'
    process.env.CLAY_WEBHOOK_URL = 'https://api.clay.com/v3/sources/webhook/firms'
    expect(await main(['--send'])).toBe(2)
    expect(err.mock.calls.flat().join('\n')).toMatch(/GTM Firms webhook/)
    err.mockRestore()
    process.env = saved
  })
})
