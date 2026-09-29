# Veroxa GTM pipeline

A go-to-market pipeline for [Veroxa](SPEC.md#1-goal), a record-keeping product for family court that sells to parents and to family law firms. This repo covers the firm side: it takes a hand-built list of family law firms, enriches them through Clay, uses a Claude research agent to find each firm's family-law decision-maker on the firm's own website, and lands everything in Supabase with an append-only event history. Scoring, HubSpot sync and human-reviewed outreach drafts come next. Nothing is ever auto-sent.

> **All firm data here is fictional.** Firm names, people, domains and emails in fixtures, tests and docs are invented. The pipeline ran against real, publicly listed firms; those records stay private.

## Results so far (10-firm pilot)

| | Before | After |
|---|---|---|
| Right decision-maker per firm | **1 of 10** (Clay people search, M3) | **10 of 10** (research agent, M4) |
| Research cost | | **about $1** for all pilot runs ($1.04, mostly Claude Haiku 4.5, one Claude Sonnet 5 retry) |
| Wrong contacts sent on to email lookup | | **0** |

- Graded against hand labels. One of the 10 correct answers is "no decision-maker listed on the site", and two firms went through the human review step (`npm run review`) before being sent on.
- The 9 decision-makers sent to Clay's email lookup all matched the labels. For one of them, the lookup returned an address on a different domain than the firm's. It was saved, then caught on review, demoted and suppressed. A database guard added afterward now rejects that case before anything is written (migration `20260928220000_research_email_domain_guard.sql`).
- 10 firms is a small eval; SPEC §8 targets 25 to 30 labeled firms.

## Architecture

```
seed CSV ──▶ Supabase (source of truth, pipeline_events audit log)
               │  ▲
     webhook   │  │  HTTP API column ──▶ clay-callback edge function
               ▼  │                       (shared secret, Zod, idempotent, one transaction)
          Clay tables: firm enrichment, decision-maker email lookup
               │
Supabase ──▶ research agent (Claude API, evidence URLs required) ──▶ review CLI ──▶ Clay
```

Details: [SPEC.md](SPEC.md) is the plan of record, and [docs/decisions/](docs/decisions/README.md) holds the ADRs.

## Stack

TypeScript (strict), Node 22 scripts, Deno for Supabase Edge Functions, Supabase Postgres with RLS, Clay, Claude API, Zod at every boundary, Vitest with PGlite for migration tests. HubSpot is planned for M6.

## Run the tests

```sh
npm ci
npm test            # unit, contract and migration tests; migrations run in-process on PGlite, no Docker or .env needed
npm run typecheck   # tsc, plus deno check on the edge functions (needs Deno)
```

`npm run test:integration` runs against a live Supabase project and needs a `.env` (see `.env.example`).
