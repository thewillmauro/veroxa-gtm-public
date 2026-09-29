// Geographic targeting. Single source of truth for the importer (M2) and
// scoring (M5). See ADR 0006.

export const NJ_COUNTIES = [
  'Atlantic', 'Bergen', 'Burlington', 'Camden', 'Cape May', 'Cumberland', 'Essex',
  'Gloucester', 'Hudson', 'Hunterdon', 'Mercer', 'Middlesex', 'Monmouth', 'Morris',
  'Ocean', 'Passaic', 'Salem', 'Somerset', 'Sussex', 'Union', 'Warren',
] as const

export type NjCounty = (typeof NJ_COUNTIES)[number]

export const TARGET_COUNTIES = {
  phase1: [{ state: 'NJ', county: 'Monmouth' }, { state: 'NJ', county: 'Ocean' }],
  phase2: [{ state: 'NJ', county: 'Middlesex' }, { state: 'NJ', county: 'Mercer' }],
} as const

export type TargetPhase = keyof typeof TARGET_COUNTIES

/** The phase currently being scored. Move to 'phase2' to widen targeting. */
export const ACTIVE_PHASES: readonly TargetPhase[] = ['phase1']

export function targetPhaseOf(state: string | null | undefined, county: string | null | undefined): TargetPhase | null {
  if (!state || !county) return null
  for (const phase of Object.keys(TARGET_COUNTIES) as TargetPhase[]) {
    if (TARGET_COUNTIES[phase].some((t) => t.state === state && t.county === county)) return phase
  }
  return null
}

export function isActiveTarget(state: string | null | undefined, county: string | null | undefined): boolean {
  const phase = targetPhaseOf(state, county)
  return phase !== null && ACTIVE_PHASES.includes(phase)
}

/** "monmouth county" -> "Monmouth", "CAPE MAY" -> "Cape May". Unknown NJ names return null. */
export function normalizeNjCounty(raw: string): NjCounty | null {
  const cleaned = raw.trim().replace(/\s+county$/i, '').replace(/\s+/g, ' ').toLowerCase()
  return NJ_COUNTIES.find((c) => c.toLowerCase() === cleaned) ?? null
}
