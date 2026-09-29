// Which researched firms may go to Clay's GTM Decision Makers table.
//
// Current state per firm = its latest `research` row (append-only, newest
// wins), plus audit events tied to that research id:
//   research_reviewed  - Will's approve/reject decision (npm run review)
//   dm_sent_to_clay    - already delivered (npm run clay:send-dm)
//
// Deliverable = a decision-maker was found AND (route is send OR route is
// needs_review and approved) AND not rejected AND not already sent.

import type { Db } from '../lib/db.js'

export type Route = 'send' | 'needs_review' | 'no_contact'
export type ReviewDecision = 'approved' | 'rejected'

export interface DecisionMaker {
  name: string
  title: string
  evidence_url: string
}

export interface FirmResearch {
  firmId: string
  firmName: string
  domain: string
  researchId: string
  model: string
  route: Route
  reasons: string[]
  dm: DecisionMaker | null
  review: { decision: ReviewDecision; note: string | null; at: string } | null
  sentAt: string | null
}

export type Eligibility = { deliver: true } | { deliver: false; why: string }

export function eligibility(r: FirmResearch): Eligibility {
  if (r.sentAt) return { deliver: false, why: `already sent ${r.sentAt}` }
  if (!r.dm) return { deliver: false, why: r.route === 'no_contact' ? 'no decision-maker named on site' : 'no decision-maker' }
  if (r.review?.decision === 'rejected') return { deliver: false, why: `rejected in review${r.review.note ? `: ${r.review.note}` : ''}` }
  if (r.route === 'send') return { deliver: true }
  if (r.route === 'needs_review') {
    return r.review?.decision === 'approved' ? { deliver: true } : { deliver: false, why: `needs review: ${r.reasons.join('; ')}` }
  }
  return { deliver: false, why: `route ${r.route}` }
}

interface ResearchRow {
  id: string
  firm_id: string
  model: string | null
  created_at: string
  output: { decision_maker?: DecisionMaker | null } | null
  evidence: { route?: Route; route_reasons?: string[] } | null
}

/** Latest research per researched firm, with its review and delivery state. */
export async function loadFirmResearch(db: Db): Promise<FirmResearch[]> {
  const { data: firms, error: fErr } = await db.from('firms').select('id, name, domain').eq('status', 'researched').order('name')
  if (fErr) throw new Error(`Loading firms failed: ${fErr.message}`)
  if (!firms.length) return []
  const ids = firms.map((f) => f.id)

  const { data: research, error: rErr } = await db
    .from('research')
    .select('id, firm_id, model, created_at, output, evidence')
    .in('firm_id', ids)
    .order('created_at', { ascending: false })
  if (rErr) throw new Error(`Loading research failed: ${rErr.message}`)

  const { data: events, error: eErr } = await db
    .from('pipeline_events')
    .select('id, entity_id, type, payload, created_at')
    .in('entity_id', ids)
    .in('type', ['research_reviewed', 'dm_sent_to_clay'])
    .order('id', { ascending: true })
  if (eErr) throw new Error(`Loading review events failed: ${eErr.message}`)

  const latest = new Map<string, ResearchRow>()
  for (const r of research as unknown as ResearchRow[]) if (!latest.has(r.firm_id)) latest.set(r.firm_id, r)

  const out: FirmResearch[] = []
  for (const f of firms) {
    const r = latest.get(f.id)
    if (!r) continue
    const mine = events.filter((e) => e.entity_id === f.id && (e.payload as { research_id?: string } | null)?.research_id === r.id)
    const lastReview = mine.filter((e) => e.type === 'research_reviewed').pop()
    const sent = mine.find((e) => e.type === 'dm_sent_to_clay')
    const reviewPayload = lastReview?.payload as { decision?: ReviewDecision; note?: string | null } | undefined
    const dm = r.output?.decision_maker ?? null
    out.push({
      firmId: f.id,
      firmName: f.name,
      domain: f.domain ?? '',
      researchId: r.id,
      model: r.model ?? '',
      route: r.evidence?.route ?? 'needs_review',
      reasons: r.evidence?.route_reasons ?? [],
      dm: dm ? { name: dm.name, title: dm.title, evidence_url: dm.evidence_url } : null,
      review: reviewPayload?.decision ? { decision: reviewPayload.decision, note: reviewPayload.note ?? null, at: lastReview!.created_at } : null,
      sentAt: sent?.created_at ?? null,
    })
  }
  return out
}

/** Accepts a firm id, a domain, or a case-insensitive fragment of the firm name. */
export function findFirm(all: FirmResearch[], ref: string): FirmResearch | { error: string } {
  const q = ref.trim().toLowerCase()
  const exact = all.filter((r) => r.firmId === q || r.domain.toLowerCase() === q || r.domain.toLowerCase() === `www.${q}`)
  if (exact.length === 1) return exact[0]!
  const partial = all.filter((r) => r.firmName.toLowerCase().includes(q) || r.domain.toLowerCase().includes(q))
  if (partial.length === 1) return partial[0]!
  if (!partial.length) return { error: `No researched firm matches "${ref}"` }
  return { error: `"${ref}" matches ${partial.length} firms: ${partial.map((p) => p.firmName).join(', ')}` }
}
