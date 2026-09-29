// M4 pilot: the cheapest possible check that a Claude
// research call can find the family-law decision-maker on a firm's own site.
//
//   npm run research:pilot -- --dry-run   # estimate only, no API call
//   npm run research:pilot                # estimate, then run if <= budget
//
// Deliberately minimal: 3 firms, 1 run each, Claude Haiku 4.5, capped tool
// use, no database writes. Every run is saved under evals/runs/ with the full
// response, so tokens and answers can be audited.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

// --- Run configuration (the knobs the cost estimate depends on) -------------

export interface Price {
  inputPerMTok: number
  outputPerMTok: number
  perSearch: number
}

export interface ModelSpec {
  id: string
  label: string
  price: Price
  /** Output cap. Sonnet 5 thinks adaptively and thinking counts as output, so it gets more room. */
  maxTokens: number
}

// Prices from platform.claude.com/docs/en/about-claude/pricing (2026-09-28); web search $10 per 1,000.
export const MODELS: Record<string, ModelSpec> = {
  haiku: { id: 'claude-haiku-4-5-20251001', label: 'haiku', price: { inputPerMTok: 1, outputPerMTok: 5, perSearch: 0.01 }, maxTokens: 2000 },
  'sonnet-5': { id: 'claude-sonnet-5', label: 'sonnet-5', price: { inputPerMTok: 2, outputPerMTok: 10, perSearch: 0.01 }, maxTokens: 4000 },
}
export const MODEL = MODELS.haiku!.id
export const PRICE = MODELS.haiku!.price
export const DEFAULT_BUDGET_USD = 1.0
export const PROMPT_VERSION = 'pilot-v2' // v2: bio-page confirmation rule
export const LIMITS = {
  fetches: 4,
  searches: 1,
  maxContentTokensPerFetch: 4000,
  maxTokens: 2000,
  // Assumptions for the worst-case estimate (not enforceable by the API):
  // The model can keep calling tools after max_uses (each call errors but
  // still costs a loop iteration that re-reads the whole context), so the
  // iteration count is bounded by the API's server-tool loop limit, not by
  // max_uses. At the limit the API returns pause_turn and the pilot stops.
  serverLoopIterations: 10,
  // Measured: one Thorne search pushed a firm to 161K input tokens (2026-09-28).
  assumedSearchResultTokens: 15000,
  assumedBasePromptTokens: 2500, // system + user + tool definitions + tool-use system prompt
}

// --- Cases: hand labels, firms fictionalized --------------------------------------

export interface ExpectedPerson {
  name: string
  aliases: string[]
}

export interface PilotCase {
  id: string
  firmName: string
  domain: string
  homepage: string
  /** status 'found' expects `person`; 'none_on_site' expects no one named. */
  expected: { status: 'found' | 'none_on_site'; person: ExpectedPerson | null; acceptable: ExpectedPerson[] }
}

const person = (name: string, ...aliases: string[]): ExpectedPerson => ({ name, aliases })

export const CASES: PilotCase[] = [
  {
    id: 'ashford',
    firmName: 'Ashford Bell & Carter',
    domain: 'ashfordbell-example.com',
    homepage: 'https://www.ashfordbell-example.com/',
    // Founder rule: the site is "Divorce & Family Law"; his bio says "founder of the firm".
    expected: {
      status: 'found',
      person: person('John P. Ashford Jr.', 'John Ashford Jr.', 'John P. Ashford'),
      acceptable: [person('Cassie Brandt Carter', 'Cassie Carter', 'Cassie A. Carter')],
    },
  },
  {
    id: 'harbor-point',
    firmName: 'Harbor Point Family Law',
    domain: 'harborpointfamilylaw-example.com',
    homepage: 'https://harborpointfamilylaw-example.com/',
    expected: { status: 'found', person: person('Abigale M. Novak', 'Abigale Novak'), acceptable: [] },
  },
  {
    id: 'whitfield',
    firmName: 'Jennifer D. Whitfield LLC',
    domain: 'jdwhitfieldlaw-example.com',
    homepage: 'https://www.jdwhitfieldlaw-example.com/',
    expected: { status: 'found', person: person('Jennifer D. Whitfield', 'Jennifer Whitfield', 'Jennifer Diane Whitfield'), acceptable: [] },
  },
  {
    id: 'delacroix',
    firmName: 'Delacroix Divorce & Family Law Group',
    domain: 'delacroixlawgroup-example.com',
    homepage: 'https://www.delacroixlawgroup-example.com/',
    expected: { status: 'found', person: person('Bari Delacroix', 'Bari Z. Delacroix'), acceptable: [] },
  },
  {
    id: 'okafor',
    firmName: 'Law Offices of Christine Okafor',
    domain: 'christineokaforfamilyesq-example.com',
    homepage: 'https://www.christineokaforfamilyesq-example.com/',
    expected: { status: 'found', person: person('Christine N. Okafor', 'Christine Okafor'), acceptable: [] },
  },
  {
    id: 'lindqvist',
    firmName: 'Lindqvist, Moretti, Hale & Serrano',
    domain: 'lindqvistlaw-example.com',
    homepage: 'https://www.lindqvistlaw-example.com/',
    // Managing partner Mark F. Serrano does no family law.
    expected: { status: 'found', person: person('James Joseph Moretti', 'James J. Moretti', 'James Moretti'), acceptable: [] },
  },
  {
    id: 'pryor',
    firmName: 'Pryor Law',
    domain: 'pryorfamilylaw-example.com',
    homepage: 'https://pryorfamilylaw-example.com/',
    expected: { status: 'found', person: person('Thomas W. Pryor', 'Thomas Pryor'), acceptable: [] },
  },
  {
    id: 'vantner',
    firmName: 'Vantner & Quill',
    domain: 'vantnerquill-example.com',
    homepage: 'https://www.vantnerquill-example.com/',
    expected: { status: 'found', person: person('Vincent C. Quill', 'Vincent Quill', 'Vince Quill'), acceptable: [] },
  },
  {
    id: 'thorne',
    firmName: 'Thorne, Abbott & Kessler',
    domain: 'thornelegal-example.com',
    homepage: 'https://www.thornelegal-example.com/',
    // The family-law page names no attorney; the managing partner is defensible, not correct.
    expected: { status: 'none_on_site', person: null, acceptable: [person('Adrian Thorne', 'Ron Thorne')] },
  },
  {
    id: 'marlowe',
    firmName: 'Law Office of Jennifer J. Marlowe',
    domain: 'jjmarlowe-example.com',
    homepage: 'https://www.jjmarlowe-example.com/',
    expected: { status: 'found', person: person('Jennifer J. Marlowe', 'Jennifer Marlowe'), acceptable: [] },
  },
]

// --- Output schema (subset of the M4 plan's schema) --------------------------

export const ResearchOutput = z.object({
  decision_maker_status: z.enum(['found', 'none_on_site', 'site_unreachable']),
  decision_maker: z
    .object({
      name: z.string(),
      title: z.string(),
      basis: z.enum(['founder', 'partner', 'managing_attorney', 'attorney', 'solo']),
      rule: z.enum(['solo_practice', 'founder_of_family_law_only_firm', 'most_senior_family_law']),
      evidence_url: z.string(),
      // Confirmed on the person's own bio/attorney page (evidence_url):
      currently_at_firm: z.boolean(),
      practices_family_law: z.boolean(),
    })
    .nullable(),
  family_law_only: z.enum(['yes', 'no', 'unclear']),
  handles_custody: z.enum(['yes', 'no', 'unclear']),
  custody_evidence_url: z.string().nullable(),
  attorney_count: z.number().int().nullable(),
})
export type ResearchOutput = z.infer<typeof ResearchOutput>

const SYSTEM = `You research one New Jersey law firm using only pages on that firm's own website, and identify its family-law decision-maker.

Rules for the decision-maker, in order:
1. Solo practice: the only attorney is the decision-maker.
2. Family-law-only firm: its founder is the decision-maker, even if their title does not mention family law.
3. Otherwise: the most senior attorney who practices family law (divorce, custody, matrimonial). Prefer Founder or Founding Member, then Partner, then Managing Attorney, then Attorney.
4. Ignore attorneys who do not practice family law, however senior.
5. If the site names no family-law attorney, use decision_maker_status "none_on_site" and decision_maker null. If you cannot load the site at all, use "site_unreachable". Never guess.

Method: fetch the homepage first, then the attorneys/team, about, or family-law pages it links to. If a page is blocked, search the firm's own domain for it. Use as few fetches as you need.

Before naming a decision-maker you must fetch that person's own bio or attorney page on the firm's site and confirm there that they are currently active at the firm (not deceased, retired, former, or of counsel) and that they practice family law. evidence_url must be that bio page. Set currently_at_firm and practices_family_law from what the bio page says. If the first candidate fails either check, move to the next attorney in the priority order and fetch their bio. For a solo practice, the attorney's about or profile page counts as the bio. Keep titles exactly as the site shows them.`

// --- Cost estimate -----------------------------------------------------------

/**
 * Worst case for one firm. Server tools run as a loop inside one request, and
 * every loop iteration re-reads the whole context, so input cost is cumulative:
 * with k tool calls there are k+1 model iterations. Worst case orders the
 * largest results first.
 */
export function worstCaseFirmUsd(limits = LIMITS, price = PRICE): { usd: number; inputTokens: number } {
  // Worst case: every result arrives as early as possible (largest first) and
  // every later iteration, up to the loop limit, re-reads it.
  const results = [
    ...Array(limits.searches).fill(limits.assumedSearchResultTokens),
    ...Array(limits.fetches).fill(limits.maxContentTokensPerFetch),
  ] as number[]
  const iterations = limits.serverLoopIterations
  let inputTokens = iterations * limits.assumedBasePromptTokens
  results.forEach((r, i) => {
    inputTokens += r * Math.max(0, iterations - 1 - i) // result i is re-read by every later iteration
  })
  const usd =
    (inputTokens / 1e6) * price.inputPerMTok +
    (limits.maxTokens / 1e6) * price.outputPerMTok +
    limits.searches * price.perSearch // failed searches aren't billed
  return { usd, inputTokens }
}

export function actualUsd(usage: Anthropic.Usage, price: Price = PRICE): number {
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  return (
    (usage.input_tokens / 1e6) * price.inputPerMTok +
    (cacheWrite / 1e6) * price.inputPerMTok * 1.25 +
    (cacheRead / 1e6) * price.inputPerMTok * 0.1 +
    (usage.output_tokens / 1e6) * price.outputPerMTok +
    searches * price.perSearch
  )
}

// --- Grading -----------------------------------------------------------------

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s*(esq\.?|esquire|jr\.?|sr\.?)\b/g, ' ')
    .replace(/\b[a-z]\.\s*/g, ' ') // middle initials like "d."
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function nameMatches(actual: string | null | undefined, expected: ExpectedPerson | null): boolean {
  if (!actual || !expected) return false
  const a = normalizeName(actual)
  return [expected.name, ...expected.aliases].some((n) => normalizeName(n) === a)
}

/** dm_correct: the labeled answer. dm_acceptable: the label or a defensible alternate. */
export function gradeAnswer(out: ResearchOutput | null, expected: PilotCase['expected']): { dm_correct: 0 | 1; dm_acceptable: 0 | 1 } {
  const name = out?.decision_maker_status === 'found' ? out.decision_maker?.name : null
  const correct =
    expected.status === 'none_on_site'
      ? out?.decision_maker_status === 'none_on_site' && !out.decision_maker
      : nameMatches(name, expected.person)
  const acceptable = correct || expected.acceptable.some((p) => nameMatches(name, p))
  return { dm_correct: correct ? 1 : 0, dm_acceptable: acceptable ? 1 : 0 }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

export interface FetchedPage {
  text: string
  title: string
}

/** Pages actually fetched in this response, with their (capped) text and title. */
export function fetchedPages(content: Anthropic.ContentBlock[]): Map<string, FetchedPage> {
  const pages = new Map<string, FetchedPage>()
  for (const block of content) {
    if (block.type !== 'web_fetch_tool_result') continue
    const result = block.content as unknown as {
      type: string
      url?: string
      content?: { title?: string; source?: { type: string; data?: string } }
    }
    if (result.type === 'web_fetch_result' && result.url) {
      const src = result.content?.source
      pages.set(result.url, { text: src?.type === 'text' ? (src.data ?? '') : '', title: result.content?.title ?? '' })
    }
  }
  return pages
}

export interface EvidenceResult {
  onDomain: boolean
  fetched: boolean
  /** Surname found in the fetched text, the page title, or the URL slug. The
   *  fetched text is capped at max_content_tokens, so a bio's name can fall past
   *  the cut; title and slug are never truncated. */
  nameFoundIn: 'text' | 'title' | 'slug' | null
  /** Surname in the page title or URL slug: the page is about this person. */
  looksLikeBio: boolean
}

export function evidenceCheck(out: ResearchOutput | null, domain: string, pages: Map<string, FetchedPage>): EvidenceResult {
  const dm = out?.decision_maker
  if (!dm) return { onDomain: false, fetched: false, nameFoundIn: null, looksLikeBio: false }
  const onDomain = hostOf(dm.evidence_url) === domain
  const norm = (u: string) => u.replace(/\/+$/, '').replace('://www.', '://').toLowerCase()
  const match = [...pages.entries()].find(([u]) => norm(u) === norm(dm.evidence_url))
  const surname = normalizeName(dm.name).split(' ').filter(Boolean).pop() ?? ''
  if (!match || !surname) return { onDomain, fetched: Boolean(match), nameFoundIn: null, looksLikeBio: false }
  const [url, page] = match
  let slug = ''
  try {
    slug = decodeURIComponent(new URL(url).pathname).toLowerCase()
  } catch {
    slug = url.toLowerCase()
  }
  const inTitle = page.title.toLowerCase().includes(surname)
  const inSlug = slug.includes(surname)
  const inText = page.text.toLowerCase().includes(surname)
  return {
    onDomain,
    fetched: true,
    nameFoundIn: inText ? 'text' : inTitle ? 'title' : inSlug ? 'slug' : null,
    looksLikeBio: inTitle || inSlug,
  }
}

export type Route = 'send' | 'needs_review' | 'no_contact'

/**
 * Only a fully verified decision-maker goes onward to Clay. Anything found but
 * failing a check is needs_review and is never sent.
 */
export function routeFor(out: ResearchOutput | null, ev: EvidenceResult): { route: Route; reasons: string[] } {
  if (!out) return { route: 'needs_review', reasons: ['no parsed output'] }
  if (out.decision_maker_status !== 'found' || !out.decision_maker) return { route: 'no_contact', reasons: [out.decision_maker_status] }
  const dm = out.decision_maker
  const reasons: string[] = []
  if (!ev.onDomain) reasons.push('evidence not on firm domain')
  if (!ev.fetched) reasons.push('evidence page was never fetched')
  else if (!ev.nameFoundIn) reasons.push('name not found on evidence page')
  if (ev.fetched && !ev.looksLikeBio) reasons.push('evidence is not a bio page')
  if (dm.currently_at_firm !== true) reasons.push('not confirmed currently at firm')
  if (dm.practices_family_law !== true) reasons.push('family-law practice not confirmed')
  return { route: reasons.length ? 'needs_review' : 'send', reasons }
}

// --- Run ---------------------------------------------------------------------

function tools(domain: string): Anthropic.ToolUnion[] {
  const allowed = [domain, `www.${domain}`]
  return [
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: LIMITS.fetches, allowed_domains: allowed, max_content_tokens: LIMITS.maxContentTokensPerFetch },
    { type: 'web_search_20250305', name: 'web_search', max_uses: LIMITS.searches, allowed_domains: allowed },
  ] as Anthropic.ToolUnion[]
}

function printEstimate(cases: PilotCase[], budget: number, spec: ModelSpec): number {
  const perFirm = worstCaseFirmUsd({ ...LIMITS, maxTokens: spec.maxTokens }, spec.price)
  const total = perFirm.usd * cases.length
  console.log(`Model ${spec.id}; ${cases.length} firms x 1 run (${cases.map((c) => c.id).join(', ')}); caps: ${LIMITS.fetches} fetches (${LIMITS.maxContentTokensPerFetch} tokens each), ${LIMITS.searches} searches, max_tokens ${spec.maxTokens}`)
  console.log(`Worst case per firm: ~${perFirm.inputTokens.toLocaleString()} input tokens (cumulative over the tool loop) -> $${perFirm.usd.toFixed(3)}`)
  console.log(`Worst case total: $${total.toFixed(3)} (budget $${budget.toFixed(2)}); assumes search results <= ${LIMITS.assumedSearchResultTokens} tokens each`)
  return total
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean', default: false }, only: { type: 'string' }, budget: { type: 'string' }, model: { type: 'string', default: 'haiku' } },
  })
  const ids = values.only?.split(',').map((x) => x.trim()).filter(Boolean)
  const unknown = ids?.filter((id) => !CASES.some((c) => c.id === id)) ?? []
  if (unknown.length) {
    console.error(`Unknown case id(s): ${unknown.join(', ')}. Known: ${CASES.map((c) => c.id).join(', ')}`)
    return 2
  }
  const cases = ids ? CASES.filter((c) => ids.includes(c.id)) : CASES
  const budget = values.budget ? Number(values.budget) : DEFAULT_BUDGET_USD
  if (!(budget > 0)) {
    console.error('--budget must be a positive number of dollars')
    return 2
  }
  const spec = MODELS[values.model]
  if (!spec) {
    console.error(`Unknown --model ${values.model}. Known: ${Object.keys(MODELS).join(', ')}`)
    return 2
  }
  const estimate = printEstimate(cases, budget, spec)
  if (estimate > budget) {
    console.error(`\nEstimate exceeds the $${budget.toFixed(2)} budget. Not running.`)
    return 1
  }
  if (values['dry-run']) {
    console.log('\nDry run: no API calls made.')
    return 0
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nANTHROPIC_API_KEY is not set. Not running.')
    return 2
  }

  // An API key that isn't scoped to a workspace must name one on every request.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID?.trim()
  const client = new Anthropic(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
  const runDir = join('evals', 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${spec.label}-pilot`)
  mkdirSync(join(runDir, 'traces'), { recursive: true })
  const worstPerFirm = worstCaseFirmUsd({ ...LIMITS, maxTokens: spec.maxTokens }, spec.price).usd
  let spent = 0
  const rows: Record<string, unknown>[] = []

  for (const c of cases) {
    if (spent + worstPerFirm > budget) {
      console.log(`\nStopping before ${c.id}: spent $${spent.toFixed(4)} + worst case $${worstPerFirm.toFixed(3)} would exceed the budget.`)
      break
    }
    const started = Date.now()
    const response = await client.messages.parse({
      model: spec.id,
      max_tokens: spec.maxTokens,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Firm: ${c.firmName}\nWebsite: ${c.homepage}\nIdentify the family-law decision-maker.` }],
      tools: tools(c.domain),
      output_config: { format: zodOutputFormat(ResearchOutput) },
    })
    const cost = actualUsd(response.usage, spec.price)
    spent += cost
    writeFileSync(join(runDir, 'traces', `${c.id}.json`), JSON.stringify(response, null, 2))

    const out = response.parsed_output ?? null
    const pages = fetchedPages(response.content)
    const ev = evidenceCheck(out, c.domain, pages)
    const routing = routeFor(out, ev)
    const row = {
      id: c.id,
      model: response.model,
      prompt_version: PROMPT_VERSION,
      stop_reason: response.stop_reason,
      latency_s: (Date.now() - started) / 1000,
      usage: response.usage,
      cost_usd: Number(cost.toFixed(5)),
      pages_fetched: [...pages.keys()],
      name_found_in: ev.nameFoundIn,
      route: routing.route,
      route_reasons: routing.reasons,
      output: out,
      expected: c.expected.person?.name ?? c.expected.status,
      acceptable: c.expected.acceptable.map((p) => p.name),
      grade: {
        ...gradeAnswer(out, c.expected),
        evidence_on_domain: ev.onDomain ? 1 : 0,
        evidence_fetched: ev.fetched ? 1 : 0,
        name_on_page: ev.nameFoundIn ? 1 : 0,
        evidence_is_bio: ev.looksLikeBio ? 1 : 0,
      },
    }
    rows.push(row)
    console.log(`\n${c.id}: ${out?.decision_maker?.name ?? out?.decision_maker_status ?? '(no parsed output)'} | expected ${c.expected.person?.name ?? c.expected.status} | $${cost.toFixed(4)} | ${routing.route}${routing.reasons.length ? ` (${routing.reasons.join('; ')})` : ''}`)
    if (response.stop_reason === 'pause_turn') console.log('  paused mid tool loop; not resumed (pilot keeps cost bounded)')
    if (cost > worstPerFirm) {
      console.log(`  actual cost exceeded the worst-case estimate; stopping so the budget holds`)
      break
    }
  }

  writeFileSync(join(runDir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`\nTotal spent: $${spent.toFixed(4)}. Results: ${runDir}/results.jsonl`)
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
