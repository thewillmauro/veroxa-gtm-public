# 0009. M3 enriches one decision-maker per firm, in one Clay table

- Status: accepted
- Date: 2026-09-28
- Amends: SPEC §7 (Clay table columns, step 2), `docs/clay/table-setup.md`

## Context

The first Clay checklist used two tables: `GTM Firms` found up to 5 people and sent them to a `GTM People` table, where the email waterfall and verification ran once per person. A lookup and a formula then rebuilt the people list on the firm row for the callback. That's four extra moving parts (second table, per-person runs, lookup, list formula) and up to 5 waterfall and verification charges per firm, before we know whether one contact per firm is enough.

Clay's Find contacts can instead return a single contact as flat columns on the firm row: `Name People`, `First Name People`, `Last Name People`, `Title People`, `Url People`.

## Decision

- **One table.** Find contacts (limit 1), the email waterfall and verification all run as columns in `GTM Firms`.
- **One decision-maker.** The title filter is Partner, Managing Attorney, or Founder. Office Manager, which SPEC §7 also lists, is dropped: with one slot it would take the place of the person who can say yes.
- **The contract doesn't change.** The `People JSON` formula builds a one-item array from the flat columns, or `[]` when no contact was found. The callback already accepts 0-50 people and upserts contacts by email, so the database, the edge function and the tests are unchanged apart from fixtures.
- A found contact without an email is still sent. The callback drops it and reports it (`people_dropped`), which keeps "no email found" visible per firm.

## Email verification (amended 2026-09-28)

Clay's Work Email waterfall verifies each provider's result with Findymail and only writes verified emails into `Work Email`, so there's no separate verification column. The `People JSON` formula sends `email_verified: true` and `email_source: "clay_waterfall"` whenever `Work Email` is present, and `null` for both when it's empty. The specific provider isn't recorded. Row 1 confirmed the flow: `cassiem@ashfordbell-example.com`, found and verified on the waterfall's first step.

**Catch-all emails count as verified.** Clay treats a catch-all domain (one that accepts mail for any address) as verified by default. For those domains, "verified" only means the domain accepts mail, not that the mailbox exists. So:

- `contacts.email_verified = true` includes catch-all addresses, and SPEC §9's "verified decision-maker email +15" will score them too.
- **Watch bounce rates in M7.** Small law firms often run catch-all domains. If hard bounces on sent drafts rise above about 2-3%, the fix is to make catch-all its own state: turn off "catch-all counts as verified" in Clay's waterfall settings, or add a catch-all status column and send `email_verified: null` for those rows. Either way, catch-alls then stop scoring the +15.

## Consequences

- At most one contact per firm in `contacts`, and one waterfall and verification charge per firm.
- If the one contact found has no findable email, that firm has no reachable decision-maker, even if a partner with a findable email exists. M3's results will show how often that happens.
- Outreach (M7) drafts to one person per firm, and there's no gatekeeper (office manager) path.
- Going back to many people is a Clay-only change: restore the people table, lookup and list formula from this file's git history (commit `930c0f3`). The callback, schema and scoring already handle several contacts per firm.

## When to bring the people table back

Revisit when any of these is true, measured on firms that reached `enriched`:

1. **Coverage.** Fewer than about 60% of custody-yes firms end up with a verified decision-maker email (`v_enrichment_coverage`, M9, or a direct query before then).
2. **Bigger firms.** Mid or large firms (11+ headcount) become a real share of the target list, e.g. when phase 2 counties (Middlesex, Mercer) come in. There, the first partner found is often not the family-law partner.
3. **Outreach needs a second person.** M7 reviews show a reason to reach a second partner or the office manager, e.g. no reply from the first contact after follow-up.
4. **Credits stop being the constraint.** A paid Clay plan makes 3-5 lookups per firm cheap.
