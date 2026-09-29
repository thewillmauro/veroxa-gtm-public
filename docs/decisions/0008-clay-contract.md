# 0008. Clay contract: lenient in, strict inside, one transaction per callback

- Status: accepted
- Date: 2026-09-28
- Implements: SPEC §7

## Decisions

**One contract file.** `supabase/functions/_shared/clay-contract.ts` defines both directions and is imported by the Node send script and the Deno `clay-callback` function. The handler logic (`clay-callback/handler.ts`) uses only `Request`, `Response` and `crypto.subtle`, so Vitest runs it directly. `index.ts` just wires in Supabase. Deno resolves `zod` through the function's `deno.json`; Node resolves it from `node_modules`.

**Outbound is strict and dry-run by default.** `npm run clay:send` prints payloads and sends nothing unless `--send` is passed. With `--send`, it refuses to POST to any host that isn't `clay.com` / `clay.run`. It only picks firms in status `new` (default 10), sends them one at a time, and retries 408/429/5xx. Success moves a firm to `sent_to_clay` via `setFirmStatus`. A failure logs `clay_send_failed` and leaves the status alone, so the next run retries it.

**Inbound is lenient at the edge, strict after.** Clay's HTTP API column commonly sends numbers and booleans as strings (`"6"`, `"TRUE"`), blanks as `""` or `"null"`, lists as JSON strings, and omits columns that found nothing. The schema accepts all of these and normalizes them. Anything it can't interpret (e.g. headcount `"about six"`, custody `"maybe"`) is a 422 with per-field messages, and the raw payload is logged as `clay_callback_rejected` so the Clay column mapping can be fixed.

**People:**
- Kept only with a valid email, lowercased and deduped (first wins). Dropped people are counted in the response and listed (index + reason) in the `clay_callback_applied` event. Their data remains in the raw payload event.
- Upserted by email **within the firm**. An email already owned by another firm is never reassigned; it's reported as `contacts_owned_by_other_firm`.
- Re-enrichment never blanks a field: `null` from Clay keeps the existing value.
- `is_decision_maker` comes from the title: partner, managing, founder/founding, owner, principal, president, shareholder, solo/sole. Office Manager is found (§7) but not a decision maker.
- Max 50 people per callback.

**Headcount (amended 2026-09-28).** Providers report either an exact count or a size range. Both are accepted: `6`, `"1,204"`, `"11-50"`, `"51 - 200 employees"`, `"11–50"`, `"10,001+"`. `headcount_est` stores the lower bound (the exact count for exact values). `firm_size_band` is derived from it:

| Headcount | Band |
|---|---|
| exactly 1 | solo |
| lower bound ≤ 10 (including `1-10`) | small |
| 11-50 | mid |
| 51+ | large |

`solo` requires the whole range to be 1. A `1-10` firm is `small`, because banding it by its lower bound alone would call a 9-person firm solo. Malformed values (`about six`, `50-11`, `11-`, `N/A`, decimals, bad comma grouping) are still a 422. A callback without a headcount keeps the existing band. When the research agent (M4) also infers a band, M4 decides which source wins.

**Custody.** `yes`/`no`/`unclear` maps to `handles_custody` true/false/null, and `unclear` never overwrites an earlier answer. The evidence URL goes in the new `firms.custody_evidence_url` (§10 syncs it to HubSpot). The research agent (M4) can still revise `handles_custody` later.

**Status.** A callback advances `new` or `sent_to_clay` to `enriched`. It never moves a firm backward, so re-running Clay on a `qualified` firm refreshes contacts without undoing scoring.

**Idempotency and atomicity.** Key = `clay_callback:<firm_id>:<sha256 of canonical JSON body>`, so key order and whitespace don't matter and any content change is a new key. `apply_clay_callback()` does everything in one transaction under a row lock on the firm: dedupe via the unique `idempotency_key` on the raw-payload event, enrichment, contacts, status, and events. A duplicate returns 200 `duplicate` and changes nothing.

**Auth.**
- `verify_jwt = false` for this function only (Clay can't send a Supabase JWT). The `x-veroxa-secret` header is checked in constant time before the body is read, so unauthenticated input is never parsed or stored.
- If no secret is configured, the function fails closed (500).
- **Rotation:** set the new value as `CLAY_CALLBACK_SECRET` and the old one as `CLAY_CALLBACK_SECRET_PREVIOUS`, update Clay's header, then remove the previous secret. The outbound `callback_secret_ref` (`v1`) records which generation a batch was sent with. Bump it on rotation.

**Responses** (visible in Clay's HTTP column): 200 applied/duplicate, 400 bad JSON, 401 bad secret, 404 unknown firm, 405 non-POST, 413 over 256 KB, 422 validation, 500 internal error (retryable).

## Consequences

- Contacts without an email aren't stored as contacts in v1. If LinkedIn-only people turn out to matter, add a `(firm_id, linkedin_url)` dedupe key in a later migration.
- Clay's column output may still surprise us. The fix is always: add a fixture under `tests/fixtures/clay/`, make it pass, and redeploy.
