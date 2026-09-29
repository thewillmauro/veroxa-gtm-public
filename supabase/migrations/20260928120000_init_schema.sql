-- M1: core GTM schema. See SPEC.md §6 and docs/decisions/ for deviations.
--
-- Access model: every table has RLS enabled with no policies, and anon /
-- authenticated have no grants. Only the service role (server-side scripts
-- and edge functions) can read or write. Nothing here is user-facing.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create type public.pipeline_status as enum (
  'new', 'sent_to_clay', 'enriched', 'researched', 'scored',
  'qualified', 'disqualified', 'synced', 'drafted', 'contacted', 'replied'
);

-- ---------------------------------------------------------------------------
-- firms
-- ---------------------------------------------------------------------------

create table public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text unique check (domain = lower(domain)),
  city text,
  county text,                            -- scoring: target counties (§9)
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  source text not null,                   -- where the row came from
  status public.pipeline_status not null default 'new',
  headcount_est int check (headcount_est is null or headcount_est >= 0),
  handles_custody boolean,
  firm_size_band text check (firm_size_band in ('solo', 'small', 'mid', 'large')),
  uses_practice_mgmt text,                -- detected tool, if any
  fit_score int,
  score_breakdown jsonb,                  -- per-rule points, so the "why" is visible (§9)
  hubspot_company_id text unique,
  last_synced_at timestamptz,             -- HubSpot: don't overwrite manual edits (§10)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index firms_status_idx on public.firms (status);

create trigger firms_set_updated_at
  before update on public.firms
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  full_name text,
  title text,
  email text unique check (email = lower(email)),
  email_source text,
  email_verified boolean,
  linkedin_url text,
  is_decision_maker boolean,
  hubspot_contact_id text unique,
  last_synced_at timestamptz,
  unsubscribed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index contacts_firm_id_idx on public.contacts (firm_id);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- research (append-only per run; latest row per firm wins)
-- ---------------------------------------------------------------------------

create table public.research (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms (id) on delete cascade,
  model text not null,
  prompt_version text not null,
  output jsonb not null,                  -- structured result (§8)
  evidence jsonb,                         -- URLs + snippets supporting output
  created_at timestamptz not null default now()
);

create index research_firm_id_created_at_idx on public.research (firm_id, created_at desc);

-- ---------------------------------------------------------------------------
-- outreach_drafts
-- ---------------------------------------------------------------------------

create table public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  subject text,
  body text,
  prompt_version text,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'sent', 'rejected')),
  reviewed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outreach_drafts_contact_id_idx on public.outreach_drafts (contact_id);
create index outreach_drafts_pending_idx on public.outreach_drafts (created_at)
  where status = 'pending_review';

create trigger outreach_drafts_set_updated_at
  before update on public.outreach_drafts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- inbound_signups
--
-- Mirrors attorney-intent signups from the Veroxa product (its attorney
-- waitlist). Veroxa stays the system of record; see ADR 0002. Parent rows
-- are not forwarded.
-- ---------------------------------------------------------------------------

create table public.inbound_signups (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,            -- e.g. 'veroxa.waitlist'
  source_id text not null,                -- row id in the source system
  email text not null check (email = lower(email)),
  persona text not null default 'unknown'
    check (persona in ('attorney', 'parent', 'unknown')),
  form text,                              -- source value from Veroxa (waitlist, demo_attorney, ...)
  utm jsonb,
  firm_name text,
  firm_size text,
  state text,
  current_tool text,
  matched_contact_id uuid references public.contacts (id) on delete set null,
  matched_firm_id uuid references public.firms (id) on delete set null,
  routed_to text,
  created_at timestamptz not null default now(),
  unique (source_system, source_id)
);

create index inbound_signups_email_idx on public.inbound_signups (email);
create index inbound_signups_matched_contact_id_idx on public.inbound_signups (matched_contact_id);
create index inbound_signups_matched_firm_id_idx on public.inbound_signups (matched_firm_id);

-- ---------------------------------------------------------------------------
-- suppressions: emails that must never get a draft, whatever their source
-- (unsubscribe reply, Veroxa unsubscribe, bounce, manual). See ADR 0003.
-- ---------------------------------------------------------------------------

create table public.suppressions (
  email text primary key check (email = lower(email)),
  reason text not null
    check (reason in ('unsubscribed', 'bounced', 'complaint', 'existing_customer', 'manual')),
  source text not null,                   -- where we learned it
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pipeline_events: append-only audit log for every state change.
-- Named pipeline_events (not events) because the Veroxa product database
-- also has an unrelated events table. See ADR 0001.
-- ---------------------------------------------------------------------------

create table public.pipeline_events (
  id bigint generated always as identity primary key,
  entity text not null,                   -- firm | contact | draft | inbound | ...
  entity_id uuid,
  type text not null,                     -- e.g. status_changed, clay_callback_received
  payload jsonb,
  idempotency_key text unique,            -- e.g. clay callback: firm_id + payload hash
  created_at timestamptz not null default now()
);

create index pipeline_events_entity_idx on public.pipeline_events (entity, entity_id, created_at desc);
create index pipeline_events_type_created_at_idx on public.pipeline_events (type, created_at desc);

create or replace function public.pipeline_events_block_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'pipeline_events is append-only';
end;
$$;

create trigger pipeline_events_append_only
  before update or delete on public.pipeline_events
  for each row execute function public.pipeline_events_block_mutation();

create trigger pipeline_events_no_truncate
  before truncate on public.pipeline_events
  for each statement execute function public.pipeline_events_block_mutation();

-- ---------------------------------------------------------------------------
-- Lock everything down to the service role.
-- ---------------------------------------------------------------------------

alter table public.firms enable row level security;
alter table public.contacts enable row level security;
alter table public.research enable row level security;
alter table public.outreach_drafts enable row level security;
alter table public.inbound_signups enable row level security;
alter table public.suppressions enable row level security;
alter table public.pipeline_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated, public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;
