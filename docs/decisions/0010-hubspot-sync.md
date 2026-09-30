# 0010. HubSpot sync: what goes in, what never gets overwritten, and replies

- Status: accepted (M6)
- Date: 2026-09-30

## Context

SPEC §10 asks for companies upserted by domain, contacts by email, the §10 custom properties, a deal in an "Attorney Pilot" pipeline only when a contact replies, and no overwriting of fields edited by hand in HubSpot (tracked with `last_synced_at`). HubSpot is a mirror; Supabase stays the source of truth (SPEC §3). Decisions below were made with Will on 2026-09-29 and 2026-09-30.

## Decision

**What syncs**
- Firms that have been researched: status `researched`, `scored`, `qualified` or later. Never `new`, `sent_to_clay`, `enriched`, or `disqualified`.
- Contacts: decision-makers with a verified email. Suppressed, held (`suppressions.source` starting `hold:`), unsubscribed, unverified, and demoted contacts are skipped, each logged once as `hubspot_skipped` with the reason.
- A qualified firm moves to `synced` once its company exists in HubSpot. Other statuses are left alone.

**Finding records (no duplicates)**
- Companies: the stored `hubspot_company_id` first, then a domain search, then create. HubSpot doesn't enforce unique domains, so we never use upsert-by-domain. If several companies share a domain, the oldest wins and the others are reported.
- Contacts: search by email, then create. Email is unique in HubSpot.
- HubSpot's "create and associate companies with contacts" setting must stay off. It made a company from a test contact's domain, which would race our search-then-create.
- Every job that writes to HubSpot holds the `hubspot-sync` lease (`job_locks`), so two runs can't create the same company.

**What we write**
- Standard fields (company name, domain, city, state, employees; contact name, title, company; owner from `HUBSPOT_OWNER_ID`) are set on create only.
- On existing records we write only the §10 properties (`veroxa_fit_score`, `veroxa_score_breakdown`, `custody_evidence_url`, `pipeline_status`, `lead_source`), and only the ones whose value changed.

**Never overwrite a manual edit**
- `last_synced_at` stores HubSpot's own `updatedAt` from our last write, not our clock. History entries stamped at exactly that time identify this integration's `sourceId`.
- A §10 property is a conflict when its newest history entry was written by anyone other than this integration and differs from Supabase. We leave it unchanged, report it, and include it in the `hubspot_company_synced` event.
- It stays a conflict on every later run, even after `last_synced_at` moves past the edit, because the check is "who wrote the current value", not "when". It clears when someone sets the HubSpot value back to match Supabase. A timestamp-only check would lose the conflict after one run and overwrite the edit on the next.

**Pipeline and replies**
- The "Attorney Pilot" deal pipeline has stages Replied, Demo scheduled, Pilot started, Converted to paid (closed won), and Not a fit (closed lost). If the plan refuses a second pipeline, the same stages go on the default pipeline with an "Attorney Pilot: " prefix. Stages are found by label at run time either way. (On 2026-09-30 HubSpot allowed a separate pipeline.)
- A reply is recorded by hand (`npm run reply -- --email`), because cold mail is sent by hand from a separate mailbox (ADR 0003). A pipeline firm's signup that inbound matching links to a firm (ADR 0002) also counts (`npm run reply -- --signups`).
- Recording a reply moves the firm to `replied` and appends `contact_replied` (idempotent). It also creates one deal per firm in Replied, associated with the company and the contact, and stores it in `firms.hubspot_deal_id` (unique). A deal with the same name in the pipeline is reused, so a run that failed after creating one can't make a second.

## Consequences

- Every HubSpot command is a dry run unless given `--send` or `--apply`: `npm run hubspot:setup`, `npm run hubspot:sync`, `npm run reply`, `npm run hubspot:sync-suppressions`.
- M7's draft generator must select `synced` firms, not only `qualified`, since syncing moves them on.
- A company that gets a new manual value for a §10 property stops receiving that property from us until the conflict is cleared. That's intended; the report and event say which.
