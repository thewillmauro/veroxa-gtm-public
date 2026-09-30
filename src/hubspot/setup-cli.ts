// npm run hubspot:setup -- [--apply]
//
// Ensures the HubSpot schema the sync needs: custom contact and company
// properties (src/hubspot/properties.ts) and the Attorney Pilot deal stages
// (src/hubspot/pipeline.ts). Dry run by default: reports what exists and
// what's missing. With --apply it creates what's missing and never modifies
// existing properties or stages. If HubSpot refuses a property (missing
// schema scope), it prints the definition for creating by hand in the UI.
// Exit codes: 0 all present/created, 1 something missing, refused, or
// mismatched, 2 usage/config error.

import { parseArgs } from 'node:util'
import { parseConfig, requireKey } from '../lib/config.js'
import { createHubSpotClient } from './client.js'
import { ensureAttorneyPilot } from './pipeline.js'
import { ensureProperties, formatForUi, PROPERTIES_BY_OBJECT, type PropertyObject } from './properties.js'

const USAGE = `Usage: npm run hubspot:setup -- [--apply]

Ensures the Veroxa custom properties (contacts, companies) and the Attorney
Pilot deal stages exist in HubSpot. Dry run by default.

Options:
  --apply      Create what's missing. Existing properties/stages are never changed.
  -h, --help   Show this help.`

export async function main(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { apply: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
    }))
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }

  let key: string
  try {
    key = requireKey(parseConfig(process.env), 'HUBSPOT_SERVICE_KEY')
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  const client = createHubSpotClient({ serviceKey: key })

  let ok = true
  for (const object of ['contacts', 'companies'] as PropertyObject[]) {
    console.log(`== ${object} properties`)
    const outcomes = await ensureProperties(client, object, { apply: values.apply })
    const refused: string[] = []
    for (const o of outcomes) {
      if (o.status === 'exists' || o.status === 'created') console.log(`OK        ${o.name} (${o.status})`)
      else if (o.status === 'missing') {
        ok = false
        console.log(`MISSING   ${o.name} (dry run; pass --apply to create)`)
      } else if (o.status === 'mismatch') {
        ok = false
        console.log(`MISMATCH  ${o.name}: ${o.problems.join('; ')}. Left unchanged; fix it in HubSpot.`)
      } else {
        ok = false
        refused.push(o.name)
        console.log(`REFUSED   ${o.name}: HTTP ${o.error.status} ${o.error.message}`)
      }
    }
    if (refused.length) {
      console.log('\nHubSpot refused to create properties with this key. Create them in the UI:')
      console.log(`Settings > Data Management > Properties > ${object === 'contacts' ? 'Contact' : 'Company'} properties > Create property\n`)
      for (const def of PROPERTIES_BY_OBJECT[object].filter((d) => refused.includes(d.name))) console.log(`${formatForUi(def, object)}\n`)
    }
  }

  console.log('== Attorney Pilot deal stages')
  const pipeline = await ensureAttorneyPilot(client, { apply: values.apply })
  if (pipeline.status === 'missing') {
    ok = false
    console.log(`MISSING   ${pipeline.plan} (dry run; pass --apply to create)`)
  } else {
    const where = pipeline.resolved.mode === 'own' ? 'own pipeline' : 'stages on the default pipeline (Free plan limit)'
    console.log(`OK        Attorney Pilot (${pipeline.status}; ${where}, pipeline id ${pipeline.resolved.pipelineId})`)
    if (pipeline.status === 'created' && pipeline.note) console.log(`          ${pipeline.note}`)
  }
  return ok ? 0 : 1
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
