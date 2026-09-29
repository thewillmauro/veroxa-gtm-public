// Typed Supabase client (service role). Server-side only: this key bypasses
// RLS, so it must never ship to a browser or be logged.
//
// Types come from `npm run db:types` after every migration.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types.js'
import { getConfig, type Config } from './config.js'

export type Db = SupabaseClient<Database>
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
export type TablesInsert<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert']
export type TablesUpdate<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update']
export type PipelineStatus = Database['public']['Enums']['pipeline_status']

export function createDb(config: Pick<Config, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>): Db {
  return createClient<Database>(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

let cached: Db | undefined

export function getDb(): Db {
  cached ??= createDb(getConfig())
  return cached
}
