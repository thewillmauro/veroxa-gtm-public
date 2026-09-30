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

## Amendment (2026-09-29): the single list covers GTM outreach only

"Single list" above means single for GTM outreach: the draft generator and anything else in this repo that decides whether to pitch someone. It does not govern email the product itself sends.

- **Product email opt-outs live in the product's own database.** The product's mail (transactional and lifecycle) has its own suppression table, fed by its email provider's webhook, and its send guard checks only that table and fails closed. Neither project reads the other's list (ADR 0001).
- **`suppressions` here is unchanged.** Same reasons, including `existing_customer`, which means "don't pitch", not "opted out". The product never reads it, so suppressing customers here can't block their account email.
- **HubSpot is a copy, not a list.** `npm run hubspot:sync-suppressions` mirrors `unsubscribed`, `bounced`, `complaint` and `manual` rows to `veroxa_email_opt_out` / `veroxa_opt_out_reason` / `veroxa_opt_out_at` on contacts that already exist in HubSpot. It never creates contacts and never reads HubSpot back into `suppressions`.

Known gap, accepted: an opt-out recorded by the product does not reach GTM `suppressions`. This is acceptable because GTM pitches attorneys, and anyone with a product account is already suppressed here as `existing_customer`. Pulling app unsubscribes into GTM `suppressions` (the M7 read-only sync under Consequences) is not planned while this holds.

Revisit if GTM ever emails parents or app users.
