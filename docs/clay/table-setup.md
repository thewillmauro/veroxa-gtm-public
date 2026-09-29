# Clay setup checklist (M3)

Builds the Clay side of SPEC §7 for the webhook table that already exists. Work on **row 1 only** until every check passes, then run rows 2-3.

Clay renames things often. If a label below doesn't match, pick the closest option; the column **names** you give are what matter, because later steps reference them.

**One table, one decision-maker per firm.** Everything happens in `GTM Firms`. Clay's Find contacts adds the contact as flat columns on the firm row, the email waterfall (which also verifies) runs on that same row, and a formula turns the contact into the one-item list the callback expects. There's no people table or lookup. See ADR 0009 for why, and for when to bring the people table back.

Row 1 should be **Ashford Bell & Carter** (`ashfordbell-example.com`, firm id starting `07d5cda2`). Rows 2-3 are Jennifer D. Whitfield LLC and Harbor Point Family Law.

Before starting, turn off **auto-run** for the table (table settings), so new columns don't spend credits on all rows at once.

---

## `GTM Firms` (the webhook table)

### 1. Extract the webhook fields

- [ ] Click the **Webhook** cell in row 1.
- [ ] For each field below, click it and choose **Add as column** (or "Extract to column").
- [ ] Rename the new columns exactly:

| Webhook field | Column name |
|---|---|
| `firm_id` | `Firm Id` |
| `name` | `Name` |
| `domain` | `Domain` |
| `city` | `City` |
| `state` | `State` |

**Check on row 1:**
- `Firm Id` is a full UUID starting `07d5cda2-c944`.
- `Domain` is `ashfordbell-example.com`, with no `https://` or `www.`.
- `State` is `NJ`.

Don't edit `Firm Id`, ever. The callback returns 404 if it changes.

### 2. Company enrichment

- [ ] **+ Add column → Enrich company** (any company-enrichment provider).
- [ ] Input: **Domain** → `Domain`.
- [ ] Outputs: add the employee count (or employee range) as its own column, named `Employee Count`.
- [ ] Run on **row 1 only**.

**Check on row 1:**
- `Employee Count` is a number (`6`, `1,204`), a size range (`11-50`, `51-200 employees`, `10,001+`), or empty. All of these work. For a range, the callback stores the lower bound and sets the firm's size band.
- Anything else, like `about 6`, `N/A` or `11 to 50`, gets a 422. If the provider gives text like that, delete the `company` line from the step 7 body rather than sending it.
- Look at the enrichment's matched company name and website. They should be Ashford Bell & Carter and `ashfordbell-example.com`. If it matched a different company, stop and fix the input.

### 3. Claygent: custody check

- [ ] **+ Add column → Use AI → Claygent**.
- [ ] Prompt, exactly:

  > Visit the website at /Domain. Does this firm's website list child custody as a practice area? Answer yes/no/unclear with the URL as evidence.

  (Type `/` and pick `Domain`, so the column reference is inserted.)
- [ ] Define two structured outputs:
  - `answer`: text, one of `yes`, `no`, `unclear`
  - `evidence_url`: text (URL)
- [ ] Add each output as its own column, named `Custody Answer` and `Custody Evidence URL`.
- [ ] Run on **row 1 only**.

**Check on row 1:**
- `Custody Answer` is `yes`, `no` or `unclear`. Case and surrounding spaces don't matter: `Yes`, `YES` and ` yes ` all count as `yes`, and a blank cell counts as `unclear`.
- Anything else gets a 422 from the callback, including `Yes.`, `Y`, `true` or a sentence like `Yes, custody is listed`. If Claygent writes a sentence, tighten the `answer` output to the three words.
- Open `Custody Evidence URL`. It should be a page on `ashfordbell-example.com` that actually lists custody. If it's a directory or another site, change the answer to `unclear` for now and note it.

### 4. Find one decision-maker

- [ ] **+ Add column → Find contacts** (at the company).
- [ ] Company: **Domain** → `Domain`.
- [ ] Job title filter, **contains any of**:
  - `Partner`
  - `Managing Attorney`
  - `Founder`
- [ ] Limit: **1 contact per company**.
- [ ] Keep the flat output columns Clay adds, with these names: `Name People`, `First Name People`, `Last Name People`, `Title People`, `Url People`.
- [ ] Run on **row 1 only**.

Office Manager is left out on purpose. With one slot per firm, it would take the place of the decision-maker (ADR 0009).

**Check on row 1:**
- `Name People` is a real person at Ashford Bell & Carter. Open `Url People` (their LinkedIn) and confirm the employer.
- `Title People` contains Partner, Managing, or Founder.
- If no one was found, the five columns are empty. That's fine; the firm is still sent with no contact (step 6 handles it).

### 5. Email waterfall (finds and verifies)

- [ ] **+ Add column → Find work email** (the waterfall), **Quick setup**, optimized for **Work Email**.
- [ ] Inputs:
  - **Full Name** → `Name People`
  - **Company Domain** → `Domain`
  - **Company Name** → the company name from Find contacts
  - **Social Profile URL** → `Url People`
  - **Personal Email** → leave empty
- [ ] Leave **Include infer-email enrichment as first step** off.
- [ ] Name the result column `Work Email`.
- [ ] Run settings: turn auto-run off, and run only when `Name People` is not empty. This saves credits on firms with no contact.
- [ ] Run on **row 1 only**.

The waterfall verifies each provider's result with Findymail and only writes verified emails into `Work Email`. **Catch-all addresses count as verified** (Clay's default), so there's no separate verification column. See ADR 0009 for what that means for bounces.

**Check on row 1:**
- `Work Email` ends in `@ashfordbell-example.com`. A personal Gmail or another firm's domain means a bad match, so clear that cell.
- The name in the email should plausibly match `Name People` (e.g. `jashford@`, `john.ashford@`).
- Empty is fine: no provider found an email Findymail would verify. The contact is still sent, and the callback reports it as dropped for having no email.

### 6. People JSON (formula)

- [ ] **+ Add column → Formula**, named `People JSON`.
- [ ] Formula. Replace each `/Column Name` with the column token (type `/` and pick the column):

```js
(/Name People || /First Name People || /Work Email)
  ? JSON.stringify([{
      full_name: /Name People || [/First Name People, /Last Name People].filter(Boolean).join(" ") || null,
      title: /Title People || null,
      email: /Work Email || null,
      email_source: /Work Email ? "clay_waterfall" : null,
      email_verified: /Work Email ? true : null,
      linkedin_url: /Url People || null
    }])
  : "[]"
```

What it produces:
- **Contact with an email:** a one-item list with `email_verified: true` and `email_source: "clay_waterfall"`. Every email in `Work Email` passed Findymail, catch-alls included.
- **Contact without an email:** a one-item list with `email`, `email_source` and `email_verified` all `null`. The callback drops it and reports it.
- **No contact found:** `[]`. The callback still enriches the firm (headcount, custody) and stores no contact.

- [ ] Run on **row 1 only**.

**Check on row 1:**
- The cell is either `[]` or starts with `[{"full_name":`.
- If it's a list, it has exactly one entry with all six keys: `full_name`, `title`, `email`, `email_source`, `email_verified`, `linkedin_url`.
- For row 1, `email` is `cassiem@ashfordbell-example.com`, `email_source` is `"clay_waterfall"` and `email_verified` is `true`.
- The cell is never empty. An empty cell would make the step 7 body invalid JSON.

### 7. HTTP API column: the callback

- [ ] **+ Add column → HTTP API**, named `Veroxa Callback`.
- [ ] Method: **POST**.
- [ ] URL:

  ```
  https://your-project-ref.supabase.co/functions/v1/clay-callback
  ```

- [ ] Headers:

  | Key | Value |
  |---|---|
  | `Content-Type` | `application/json` |
  | `x-veroxa-secret` | open `~/veroxa-gtm/.env` yourself and copy the value after `CLAY_CALLBACK_SECRET=` |

- [ ] Body. Type it as below, replacing each `/Column Name` with the column token (type `/` and pick the column):

  ```json
  {
    "firm_id": "/Firm Id",
    "company": { "headcount": "/Employee Count" },
    "custody": {
      "answer": "/Custody Answer",
      "evidence_url": "/Custody Evidence URL"
    },
    "people": /People JSON
  }
  ```

  - `People JSON` goes **without** quotes around it. With quotes it also works, because the callback accepts a JSON string there.
  - The company description is left out on purpose. Free text with quotes or line breaks can break the JSON, and the callback doesn't store it.
- [ ] Run condition (if offered): only when `Custody Answer` and `People JSON` are not empty.
- [ ] Run on **row 1 only**.

**Check on row 1:** the response should be status **200** with `"result":"applied"` and `"status_to":"enriched"`.
- `contacts_upserted` is `1` if a contact with an email was found.
- It's `0` with `people_dropped: 1` if a contact was found without an email.
- It's `0` with `people_dropped: 0` if no contact was found.

Anything else:

| Response | Meaning | Fix |
|---|---|---|
| 200 `duplicate` | This exact payload was already stored | Nothing. Safe. |
| 401 `unauthorized` | Header missing or wrong | Re-copy the secret; check the header name is `x-veroxa-secret`. |
| 404 `unknown_firm` | `Firm Id` doesn't match the database | `Firm Id` was edited or mis-extracted; redo step 1. |
| 422 `validation_failed` | A field couldn't be read; `details` says which | Fix that column (usually `Custody Answer`, `Employee Count` or `People JSON`). |
| 400 `invalid_json` | The body isn't valid JSON | Usually an empty `People JSON` cell, or quotes around or inside a token; compare against the body above. |
| 500 | Server error | Re-run the cell once; if it repeats, tell Claude. |

Then tell Claude "row 1 is back". Claude checks the database: firm `enriched`, contact stored, events logged.

---

## Rows 2-3

Only after row 1 passes every check above:

- [ ] Run steps 2-7 on rows 2-3, in order, one column at a time.
- [ ] Repeat each check above per row, then tell Claude.

The remaining 7 firms for M3's 10 are sent afterwards with `npm run clay:send -- --limit 7 --send`.
