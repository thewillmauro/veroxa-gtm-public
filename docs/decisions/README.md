# Decisions

One short ADR per non-obvious choice or deviation from [SPEC.md](../../SPEC.md).

| ADR | Decision |
|---|---|
| [0001](0001-separate-supabase-project.md) | GTM lives in its own Supabase project |
| [0002](0002-inbound-mirrors-veroxa.md) | Inbound mirrors Veroxa's existing capture instead of new site forms |
| [0003](0003-suppression-and-sending-domain.md) | One suppression list, and cold outreach never sends from the product's domain |
| 0004 | Omitted: covers private Veroxa product internals |
| [0005](0005-local-migration-tests-pglite.md) | Test migrations locally with PGlite, not Docker |
| [0006](0006-seed-source-and-target-counties.md) | Seed from a hand-built CSV; target Monmouth and Ocean first |
| 0007 | Omitted: covers private Veroxa product internals |
| [0008](0008-clay-contract.md) | Clay contract: lenient in, strict inside, one transaction per callback |
| [0009](0009-one-decision-maker-per-firm.md) | M3 enriches one decision-maker per firm, in one Clay table |
| [0010](0010-hubspot-sync.md) | HubSpot sync: create-only standard fields, never overwrite manual edits, a deal only on reply |
