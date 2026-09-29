// Deno entry point for clay-callback. All logic lives in handler.ts.
//
// Secrets (supabase secrets set ...):
//   CLAY_CALLBACK_SECRET            required
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// JWT verification is off for this function (config.toml): Clay can't send a
// Supabase JWT. The shared secret header is the auth.

import { createClient } from '@supabase/supabase-js'
import { handleClayCallback, type ApplyResult } from './handler.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const secrets = [Deno.env.get('CLAY_CALLBACK_SECRET') ?? '']

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, fn: 'clay-callback', ...fields })
  if (level === 'info') console.log(line)
  else console.error(line)
}

Deno.serve((req) =>
  handleClayCallback(req, {
    secrets,
    log,
    async apply({ callback, idempotencyKey, raw }) {
      const { data, error } = await supabase.rpc('apply_clay_callback', {
        p_firm_id: callback.firmId,
        p_idempotency_key: idempotencyKey,
        p_raw: raw,
        p_headcount: callback.headcount,
        p_firm_size_band: callback.firmSizeBand,
        p_handles_custody: callback.custody.handlesCustody,
        p_custody_evidence_url: callback.custody.evidenceUrl,
        p_people: callback.people.map((p) => ({
          email: p.email,
          full_name: p.fullName,
          title: p.title,
          email_source: p.emailSource,
          email_verified: p.emailVerified,
          linkedin_url: p.linkedinUrl,
          is_decision_maker: p.isDecisionMaker,
          decision_maker_source: p.decisionMakerSource,
        })),
        p_dropped_people: callback.droppedPeople,
      })
      if (error) throw new Error(`apply_clay_callback failed: ${error.message}`)
      return data as ApplyResult
    },
    async logRejected({ firmId, reason, errors, raw }) {
      const { error } = await supabase.from('pipeline_events').insert({
        entity: firmId ? 'firm' : 'system',
        entity_id: firmId,
        type: 'clay_callback_rejected',
        payload: { reason, errors: errors ?? null, raw: raw ?? null },
      })
      if (error) log('error', 'clay_callback_log_rejected_failed', { error: error.message })
    },
  }).catch((err) => {
    log('error', 'clay_callback_unhandled', { error: err instanceof Error ? err.message : String(err) })
    // 500 so Clay's HTTP column shows a failure and can be re-run.
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }),
)
