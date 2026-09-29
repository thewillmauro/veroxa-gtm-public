# Seed CSVs

Hand-built firm lists (ADR 0006). Two files ship here:

- `firms.template.csv`: headers only. Copy it and fill in your own firms.
- `firms.sample.csv`: five fictional firms, to try the importer.

```sh
npm run seed -- data/seed/firms.sample.csv --dry-run   # validate, show the plan, write nothing
npm run seed -- data/seed/firms.sample.csv             # import
```

## Columns

| Column | Required | Notes |
|---|---|---|
| `name` | yes | Firm name as it appears on its site. |
| `website` | yes | The firm's **own** site. Any form works: `https://www.smithlaw.com/family`, `smithlaw.com`. Stored as the bare domain (`smithlaw.com`), which is also the dedupe key. Directory or social profiles (Avvo, Justia, FindLaw, Facebook, LinkedIn, ...) are rejected. |
| `city` | no | |
| `county` | no, but needed for scoring | NJ counties are checked against the 21 real ones. `Monmouth County` and `monmouth` both become `Monmouth`. Phase 1 targets: Monmouth, Ocean. Phase 2: Middlesex, Mercer. |
| `state` | yes | 2-letter code (`NJ`). `New Jersey` is accepted. |

Column order doesn't matter; headers are case-insensitive. Extra columns are ignored with a warning.

## Rules

- A row whose domain already appears earlier in the file is skipped (first one wins).
- A firm whose domain is already in the database is left unchanged. Re-running the same file is safe.
- Any invalid row stops the whole import (exit code 1) so the file gets fixed. `--skip-invalid` imports the valid rows anyway.
- Every imported firm gets `status = new`, `source = manual_csv` (or `--source <tag>`) and a `firm_imported` row in `pipeline_events` naming the file, its hash and the row number.

## Sourcing (SPEC §2)

Only record firms from sources whose terms allow it: the firm's own website, your own knowledge, referrals. Never court records, dockets or case filings.
