import { createClient } from '@supabase/supabase-js'

// We don't have generated Supabase types for this service,
// so we use `any` to avoid fighting `never` inference on every query.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null

export function getSupabase(): any {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return _client
}
