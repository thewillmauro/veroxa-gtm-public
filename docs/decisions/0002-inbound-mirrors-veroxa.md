# 0002. Inbound mirrors Veroxa's existing capture instead of new site forms

- Status: accepted (implementation in M8)
- Date: 2026-09-28

## Context

SPEC §12 describes site forms posting to a new `inbound` edge function. But the Veroxa product already captures inbound signups from both parents and attorneys, with its own rate limiting and lifecycle email.

## Decision

- Veroxa remains the system of record for inbound. No new forms, no second write path from the site.
- The GTM `inbound` edge function receives **attorney-intent** signups only. Filtering happens on the product side, before anything is sent, so parent rows never leave the product database. Requests carry a shared secret header.
- Rows are keyed by `(source_system, source_id)` and upserted, so replays are harmless and later edits to the same signup update it.
- On receipt, GTM matches the email to `contacts` and its domain to `firms`, fills `matched_contact_id` / `matched_firm_id`, and advances a matched firm to `replied`. That closes the loop: an outbound contact who later signs up shows up as a reply.
- Parents are not forwarded. SPEC §12's "parents go to a lifecycle list" is already true inside the product. Keeping parent emails out of a prospecting DB that talks to Clay and HubSpot is the safer default for custody-adjacent users.

## Consequences

- Turning on the forwarding is a configuration change on the production product; do it deliberately at M8.
- `inbound_signups.persona` still allows `parent`/`unknown` so the table doesn't need a migration if that decision changes.
