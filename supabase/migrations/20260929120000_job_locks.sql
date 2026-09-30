-- Job leases: at most one run of a named job at a time. Used by the HubSpot
-- syncs so two runs can't race (company upserts search-then-create, and
-- HubSpot's search index lags writes, so concurrent runs could create
-- duplicate companies).
--
-- Not pg_advisory_lock: scripts reach Postgres through PostgREST, where each
-- rpc() may land on a different pooled connection (a session lock would be
-- held by the wrong connection) and a transaction lock ends with the call.
-- A lease row works across calls and frees itself if the holder crashes.

create table public.job_locks (
  name text primary key,
  holder uuid not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.job_locks enable row level security;

-- Take the lease if it's free, expired, or already ours (renewal).
create or replace function public.acquire_job_lock(p_name text, p_holder uuid, p_ttl_seconds int)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows int;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'acquire_job_lock: ttl must be 1..3600 seconds, got %', p_ttl_seconds;
  end if;

  insert into public.job_locks (name, holder, acquired_at, expires_at)
  values (p_name, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder = excluded.holder,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
    where public.job_locks.expires_at < now()
       or public.job_locks.holder = excluded.holder;

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Release only our own lease; a stale holder can't free someone else's.
create or replace function public.release_job_lock(p_name text, p_holder uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows int;
begin
  delete from public.job_locks where name = p_name and holder = p_holder;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.acquire_job_lock(text, uuid, int) from public, anon, authenticated;
revoke execute on function public.release_job_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_job_lock(text, uuid, int) to service_role;
grant execute on function public.release_job_lock(text, uuid) to service_role;
