// Typed, validated environment config. Every script reads config through
// here so a missing or malformed secret fails fast at startup instead of
// halfway through a batch.
//
// Load .env with Node's built-in flag: `tsx --env-file=.env src/...`.

import { z } from 'zod'

const ConfigSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAY_WEBHOOK_URL: z.url().optional(),
  // GTM Decision Makers table's webhook source (docs/clay/dm-table-setup.md).
  CLAY_DM_WEBHOOK_URL: z.url().optional(),
  // Optional: only if the Clay webhook source has an auth token enabled.
  CLAY_WEBHOOK_AUTH_TOKEN: z.string().min(1).optional(),
  CLAY_CALLBACK_SECRET: z.string().min(16).optional(),
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof ConfigSchema>

export function parseConfig(env: Record<string, string | undefined>): Config {
  // A blank line like `CLAY_WEBHOOK_URL=` in .env means "not set", not "set to ''".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''))
  const result = ConfigSchema.safeParse(cleaned)
  if (!result.success) {
    // Report key names only; never echo values, they may be secrets.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment config:\n  ${problems.join('\n  ')}`)
  }
  return result.data
}

let cached: Config | undefined

export function getConfig(): Config {
  cached ??= parseConfig(process.env)
  return cached
}

/** Narrow an optional key to required for the step that needs it. */
export function requireKey<K extends keyof Config>(config: Config, key: K): NonNullable<Config[K]> {
  const value = config[key]
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required config: ${String(key)}`)
  }
  return value as NonNullable<Config[K]>
}
