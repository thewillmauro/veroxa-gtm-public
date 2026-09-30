// "Attorney Pilot" deal pipeline (SPEC §10: a deal is created only when a
// contact replies).
//
// HubSpot Free allows one deal pipeline. We try to create our own; if
// HubSpot refuses because of the plan limit, the same stages are added to
// the default pipeline with an "Attorney Pilot: " label prefix instead.
// Either way, resolveAttorneyPilot() finds the stages by label at run time,
// so nothing depends on which mode was used or on stage IDs in config.

import { z } from 'zod'
import { HubSpotError, type HubSpotClient } from './client.js'

export const PIPELINE_LABEL = 'Attorney Pilot'
export const FALLBACK_PREFIX = 'Attorney Pilot: '

export const STAGES = [
  { key: 'replied', label: 'Replied', probability: '0.2', closed: false },
  { key: 'demo_scheduled', label: 'Demo scheduled', probability: '0.4', closed: false },
  { key: 'pilot_started', label: 'Pilot started', probability: '0.6', closed: false },
  { key: 'won', label: 'Converted to paid', probability: '1.0', closed: true },
  { key: 'lost', label: 'Not a fit', probability: '0.0', closed: true },
] as const

export type StageKey = (typeof STAGES)[number]['key']

const PipelinesSchema = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          displayOrder: z.number().optional(),
          stages: z.array(z.object({ id: z.string(), label: z.string(), displayOrder: z.number().optional() }).loose()),
        })
        .loose(),
    ),
  })
  .loose()

type Pipeline = z.infer<typeof PipelinesSchema>['results'][number]

export interface ResolvedPipeline {
  mode: 'own' | 'default'
  pipelineId: string
  stageIds: Record<StageKey, string>
}

function stageBody(s: (typeof STAGES)[number], label: string, displayOrder: number) {
  return { label, displayOrder, metadata: { probability: s.probability, ...(s.closed ? { isClosed: 'true' } : {}) } }
}

/** Pure: find our stages in the account's pipelines. Null if not all present. */
export function findAttorneyPilot(pipelines: Pipeline[]): ResolvedPipeline | null {
  const own = pipelines.find((p) => p.label === PIPELINE_LABEL)
  const [mode, pipeline, prefix] = own
    ? (['own', own, ''] as const)
    : (['default', pipelines.find((p) => p.id === 'default') ?? pipelines[0], FALLBACK_PREFIX] as const)
  if (!pipeline) return null

  const stageIds: Partial<Record<StageKey, string>> = {}
  for (const s of STAGES) {
    const found = pipeline.stages.find((st) => st.label === `${prefix}${s.label}`)
    if (found) stageIds[s.key] = found.id
  }
  if (STAGES.some((s) => !stageIds[s.key])) return null
  return { mode, pipelineId: pipeline.id, stageIds: stageIds as Record<StageKey, string> }
}

async function listPipelines(client: HubSpotClient): Promise<Pipeline[]> {
  return (await client.request('GET', '/crm/v3/pipelines/deals', PipelinesSchema)).results
}

export async function resolveAttorneyPilot(client: HubSpotClient): Promise<ResolvedPipeline> {
  const resolved = findAttorneyPilot(await listPipelines(client))
  if (!resolved) throw new Error(`The "${PIPELINE_LABEL}" deal stages don't exist yet. Run: npm run hubspot:setup -- --apply`)
  return resolved
}

/** HubSpot's refusal when the plan allows no more pipelines. */
export function isPipelineLimitError(err: unknown): boolean {
  return err instanceof HubSpotError && [400, 403].includes(err.status) && /limit|maximum|upgrade|tier|subscription/i.test(err.message)
}

export type PipelineOutcome =
  | { status: 'exists'; resolved: ResolvedPipeline }
  | { status: 'missing'; plan: string } // dry run
  | { status: 'created'; resolved: ResolvedPipeline; note?: string }

export async function ensureAttorneyPilot(client: HubSpotClient, options: { apply: boolean }): Promise<PipelineOutcome> {
  const pipelines = await listPipelines(client)
  const existing = findAttorneyPilot(pipelines)
  if (existing) return { status: 'exists', resolved: existing }
  if (!options.apply) {
    return { status: 'missing', plan: `create pipeline "${PIPELINE_LABEL}" (${STAGES.length} stages), or add prefixed stages to the default pipeline if the plan allows only one` }
  }

  const own = pipelines.find((p) => p.label === PIPELINE_LABEL)
  const def = pipelines.find((p) => p.id === 'default') ?? pipelines[0]
  // A partially created fallback means we already know the plan limit applies.
  const partialFallback = def?.stages.some((s) => s.label.startsWith(FALLBACK_PREFIX))
  let note: string | undefined

  if (!own && !partialFallback) {
    try {
      await client.request('POST', '/crm/v3/pipelines/deals', z.unknown(), {
        body: { label: PIPELINE_LABEL, displayOrder: pipelines.length, stages: STAGES.map((s, i) => stageBody(s, s.label, i)) },
      })
      return { status: 'created', resolved: await resolveAttorneyPilot(client) }
    } catch (err) {
      if (!isPipelineLimitError(err)) throw err
      note = `HubSpot refused a second pipeline (${(err as Error).message}); added stages to the default pipeline instead.`
    }
  }

  // Fill in missing stages: on our own pipeline if it exists (partial
  // create), otherwise prefixed on the default pipeline.
  const target = own ?? def
  const prefix = own ? '' : FALLBACK_PREFIX
  if (!target) throw new Error('No deal pipeline found')
  const order = Math.max(0, ...target.stages.map((s) => s.displayOrder ?? 0)) + 1
  let i = 0
  for (const s of STAGES) {
    const label = `${prefix}${s.label}`
    if (target.stages.some((st) => st.label === label)) continue
    // Not idempotent (no unique key on stage labels), so only 429 is retried.
    await client.request('POST', `/crm/v3/pipelines/deals/${target.id}/stages`, z.unknown(), { body: stageBody(s, label, order + i++) })
  }
  return { status: 'created', resolved: await resolveAttorneyPilot(client), ...(note ? { note } : {}) }
}
