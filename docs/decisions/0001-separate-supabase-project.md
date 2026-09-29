# 0001. GTM lives in its own Supabase project

- Status: accepted
- Date: 2026-09-28

## Context

Veroxa's product database holds family-court records for parents in custody cases, under RLS. The GTM pipeline stores prospect data about law firms and runs third-party enrichment (Clay, HubSpot, Claude) against it. SPEC §1 also wants this repo to stand alone as a portfolio piece.

## Decision

- The pipeline uses a separate Supabase project in a separate org. This repo is linked only to it.
- Nothing in this repo writes to the product database. Data flows one way, product to GTM, and only for attorney-intent signups (ADR 0002).
- The audit table is `pipeline_events` rather than SPEC §6's `events`, because the product database also has an `events` table with an unrelated meaning. Two tables with the same name and different meanings in the same company's systems invite a wrong query.
- Scheduled batch work runs on the GTM project's `pg_cron` (or GitHub Actions), not in the product's hosting, so a GTM schedule change can never break a product deploy.

## Consequences

- A GTM bug or leaked GTM key can't reach family-court data.
- Cross-system reporting (e.g. "outbound contact later signed up") needs an explicit bridge instead of a join. Accepted: the volume is tiny and the bridge is one-directional.
- Two sets of keys to manage.

## Schema additions beyond SPEC §6

- `firms.county` for the target-county signal in §9.
- `firms.score_breakdown` because §9 says to store the breakdown, not just the total.
- `firms.last_synced_at` / `contacts.last_synced_at` because §10 says to track it.
- `updated_at` + trigger on every mutable table.
- `pipeline_events.idempotency_key` (unique) for §7's "idempotent on firm_id + payload hash".
- `suppressions` table (ADR 0003).
- `inbound_signups` source columns and match columns (ADR 0002).
- Check constraints: lowercase email/domain, 2-letter state, enum-like text columns.
- Append-only trigger on `pipeline_events` (update, delete, truncate).
