# 0006. Seed from a hand-built CSV; target Monmouth and Ocean first

- Status: accepted
- Date: 2026-09-28
- Resolves: SPEC §16 (seed source, target counties)

## Context

M2 needs an initial set of NJ family law firms (target lowered from 50 to 30 on 2026-09-28). SPEC §2 rules out sources whose terms prohibit this use, and bans court records and dockets as lead sources. Scoring (§9) awards points for being in a target county, which had not been chosen.

## Decision

**Seed source: a hand-built CSV.** Will researches firms by hand and records `name, website, city, county, state` in a CSV that follows `data/seed/firms.template.csv`, then imports it with `npm run seed`. Every imported row gets `source = 'manual_csv'` (overridable per batch with `--source`, e.g. `manual_csv:referral`).

- No directory scraping, no paid lead lists, no third-party lead APIs for v1. A hand-built list is small, clean, and has no terms-of-use risk.
- `website` is required, because Clay enrichment (M3) keys on domain. A firm whose only web presence is a directory profile (Avvo, Justia, FindLaw, Facebook, ...) is rejected: its "domain" would be the directory's, and it would collide with every other firm on that directory.

**Target counties:**

| Phase | State | Counties |
|---|---|---|
| 1 (v1) | NJ | Monmouth, Ocean |
| 2 | NJ | Middlesex, Mercer |

- NY is out of scope for v1 (SPEC §1 said NJ/NY).
- Counties live in one place, `src/lib/targets.ts`. The importer validates NJ county names against all 21 NJ counties (catches typos like "Monmoth") and warns on, but still imports, firms outside the current phase. Scoring (M5) reads the same constant, so moving to phase 2 is a one-line change.
- County is stored normalized: `"Monmouth County"`, `"monmouth"` → `Monmouth`.

## Consequences

- Seed volume is limited by Will's research time. Fine for M2's 30 firms; revisit if the funnel needs more top-of-funnel than hand research can feed.
- Phase 2 counties can be imported now for later use; they just don't score the county points until phase 2 is switched on.
