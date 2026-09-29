# 0003. One suppression list, and cold outreach never sends from the product's domain

- Status: accepted (enforced in M7)
- Date: 2026-09-28

## Context

Unsubscribes can come from several places: the product's own email preferences, replies to cold email, and HubSpot. CAN-SPAM requires honoring any of them. Separately, the product's transactional mail (welcome, trial, password reset) and its lifecycle email send from the product's domain.

## Decision

- `suppressions` (email PK, reason, source) is the single list the draft generator checks. An email on it, or with `contacts.unsubscribed = true`, never gets a draft.
- Existing Veroxa customers are suppressed as `existing_customer`, so a paying attorney never gets a cold pitch.
- Cold outreach is sent by Will by hand from a separate mailbox on a separate domain, never from the product's domain and never through its lifecycle email. A spam complaint on cold mail must not hurt deliverability of password resets and trial emails.

## Consequences

- M7 needs a small read-only sync that pulls unsubscribed emails from the product into `suppressions`.
- A new sending domain needs SPF/DKIM/DMARC and warm-up before M7 volume.
