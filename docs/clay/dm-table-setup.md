# Clay setup checklist: GTM Decision Makers table (M4)

Second Clay table. It receives **research-verified decision-makers** (one row per firm, sent by `npm run clay:send-dm`), finds and verifies their work email, and calls back to `clay-callback`. There's no Find contacts, company enrichment or Claygent here: the research agent already picked the person, and the firm's headcount and custody are already stored from `GTM Firms`.

Only reviewed rows ever arrive: `clay:send-dm` sends firms whose research routed to `send`, plus `needs_review` firms you approved with `npm run review`.

## Rules that worked in GTM Firms (apply them everywhere below)

- **Formulas:** open the formula column, type a **plain-English description** into the formula generator's description box, and let Clay write the formula. Pasting code into the Formula field failed.
- **Column references:** insert them with **`/` and pick the column from the menu**. Typed `/Column` text is sent literally.
- **HTTP body:** a single `Callback Body` token, nothing else.
- **Secret header:** delete the header row and re-add it, then paste the secret from the clipboard (step 5).
- **Auto-run off** on the table and on every column. Run each column on row 1 by hand, and run the callback only after you've checked that row.

Row 1 will be **Ashford Bell & Carter** (decision-maker John P. Ashford Jr.). The other rows that can arrive are listed in `npm run clay:send-dm` (dry run).

---

### 1. Table and webhook source

- [ ] Create a new table named `GTM Decision Makers`.
- [ ] **Add source → Webhook.** Copy the webhook URL Clay shows.
- [ ] In `~/veroxa-gtm/.env`, paste it after `CLAY_DM_WEBHOOK_URL=`. This must be the **new** table's URL; `clay:send-dm` refuses the GTM Firms webhook.
- [ ] Table settings: **auto-run off**.
- [ ] Tell Claude the URL is set. Claude sends **one** row (`npm run clay:send-dm -- --firm ashfordbell-example.com --send`), so the columns can be created from a real payload.
- [ ] Click the Webhook cell in row 1 and add each field as a column, keeping the field names as column names:

| Field | Column name | Row 1 value |
|---|---|---|
| `firm_id` | `firm_id` | `07d5cda2-c944-4c10-b4e2-5a38516e3f13` |
| `firm_name` | `firm_name` | `Ashford Bell & Carter` (rows sent before 2026-09-28 23:15 UTC, i.e. Ashford, don't have it) |
| `domain` | `domain` | `ashfordbell-example.com` |
| `dm_name` | `dm_name` | `John P. Ashford Jr.` |
| `dm_title` | `dm_title` | `Founder and Senior Partner` |
| `evidence_url` | `evidence_url` | `https://www.ashfordbell-example.com/attorneys/john-p-ashford-jr-esq/` |

**Check on row 1:** the values match the table. `dm_name` has no "Esq.". Never edit `firm_id`: the callback returns 404 if it changes.

### 2. Work Email waterfall

- [ ] **+ Add column → Find work email** (the waterfall). **Quick setup**, optimized for **Work Email**.
- [ ] Inputs. **Check each one; last time Clay auto-mapped Full Name to the wrong column.**
  - **Full Name** → `dm_name` (inserted with `/`)
  - **Company Domain** → `domain`
  - **Company Name** → `firm_name` (added 2026-09-28; empty on the Ashford row, which is fine)
  - **Social Profile URL**, **Personal Email**: leave empty. Research doesn't provide a LinkedIn URL, and a guessed one could point the waterfall at a different person.
- [ ] **Include infer-email enrichment as first step**: off.
- [ ] Name the result column `Work Email`.
- [ ] Run settings: auto-run **off**; run only when `dm_name` is not empty.
- [ ] Run on **row 1 only**.

The waterfall verifies each provider's result with Findymail and only writes verified emails; catch-all addresses count as verified (ADR 0009).

**Check on row 1:**
- The Full Name input still shows `dm_name`, not `dm_title` or another column.
- `Work Email` ends in `@ashfordbell-example.com` and plausibly belongs to John P. Ashford Jr. (e.g. `jashford@`, `john.ashford@`). Watch for **John P. Ashford III** (`jashford3@`-style): he's a different person at the same firm. If it's his address, clear the cell and tell Claude.
- Empty is acceptable: the callback then stores nothing and demotes no one.

### 3. People JSON (formula)

- [ ] **+ Add column → Formula**, named `People JSON`.
- [ ] In the formula generator's description box, type this, inserting each column with `/` where it says so:

  > Return a JSON string of a list with one object. The object has: full_name set to [/dm_name], title set to [/dm_title], email set to [/Work Email] or null if it is empty, email_source set to the text "clay_waterfall" if [/Work Email] has a value and otherwise null, email_verified set to true if [/Work Email] has a value and otherwise null, linkedin_url set to null, and decision_maker_source set to the text "research_agent".

- [ ] Let the generator write the formula; don't edit or paste code.
- [ ] Run on **row 1 only**.

**Check on row 1:** the cell reads like this (your email in place of `jashford@…`):

```json
[{"full_name":"John P. Ashford Jr.","title":"Founder and Senior Partner","email":"jashford@ashfordbell-example.com","email_source":"clay_waterfall","email_verified":true,"linkedin_url":null,"decision_maker_source":"research_agent"}]
```

- Exactly one object, all seven keys.
- `decision_maker_source` is exactly `research_agent`; any other value gets a 422.
- `email_verified` is `true` or `null`, never a word.

### 4. Callback Body (formula)

- [ ] **+ Add column → Formula**, named `Callback Body`.
- [ ] Description box, with `/` column inserts:

  > Return a JSON string of an object with two keys: firm_id set to [/firm_id], and people set to [/People JSON] parsed as JSON, or an empty list if [/People JSON] is empty.

- [ ] Run on **row 1 only**.

**Check on row 1:**

```json
{"firm_id":"07d5cda2-c944-4c10-b4e2-5a38516e3f13","people":[{"full_name":"John P. Ashford Jr.","title":"Founder and Senior Partner","email":"jashford@ashfordbell-example.com","email_source":"clay_waterfall","email_verified":true,"linkedin_url":null,"decision_maker_source":"research_agent"}]}
```

- **Only** `firm_id` and `people`: no `company`, no `custody`. The callback accepts that and keeps the firm's stored headcount and custody unchanged (tested 2026-09-28).
- `people` is a real list (starts with `[{`), not a string in quotes. A quoted string would also be accepted, but the list is what worked in GTM Firms.
- `firm_id` is the full UUID.

### 5. HTTP API column: callback

- [ ] **+ Add column → HTTP API**, named `Veroxa Callback`.
- [ ] Method **POST**. URL:

  ```
  https://your-project-ref.supabase.co/functions/v1/clay-callback
  ```

- [ ] Headers:
  - `Content-Type`: `application/json`
  - `x-veroxa-secret`: **delete the header row if it exists, then add it again.** In your own terminal, copy the secret without printing it:

    ```sh
    grep '^CLAY_CALLBACK_SECRET=' ~/veroxa-gtm/.env | cut -d= -f2- | tr -d '"\n' | pbcopy
    ```

    Then paste into the value field **without copying anything else in between**.
- [ ] Body: **only** the `Callback Body` token (insert with `/`). No braces, no other text.
- [ ] Run condition: only when `Callback Body` is not empty. Auto-run **off**.
- [ ] Run on **row 1 only**, after steps 2-4 passed their checks.

**Check on row 1:** status **200**, `"result":"applied"`, `"contacts_upserted":1`. For Ashford, expect `"demoted_contacts":["cassiem@ashfordbell-example.com"]`: Cassie Brandt Carter stays stored as a contact but is no longer marked the decision-maker (she's the label's acceptable alternate, not the decision-maker). `status_from`/`status_to` are both `researched`.

| Response | Meaning | Fix |
|---|---|---|
| 200 `duplicate` | This exact body was already applied | Nothing. Safe. |
| 401 | Secret header wrong or missing | Redo the header row with the pbpaste step. |
| 404 `unknown_firm` | `firm_id` changed | Redo step 1's extraction; don't edit `firm_id`. |
| 422 | A field couldn't be read; `details` says which | Usually `decision_maker_source` or `email_verified` in step 3. |
| 400 `invalid_json` | The body isn't JSON | The body must be the single `Callback Body` token. |
| 500 | Transient server error | Re-run the cell once (the function retries transient database errors itself). |

Then tell Claude "DM row 1 is back". Claude checks the database: John P. Ashford Jr. stored with `decision_maker_source = research_agent`, Cassie demoted, events logged.

---

## Remaining rows

Only after row 1 passes:

- [ ] Tell Claude, who sends the other deliverable firms (`npm run clay:send-dm -- --send`).
- [ ] For each new row, run steps 2, 3, 4 and check them, then run step 5 on that row.
- [ ] Expected demotions: Vantner & Quill (`crv@vantnerquill-example.com`) and Marlowe (`cridley@jjmarlowe-example.com`), the wrong picks from GTM Firms. Both stay suppressed.
- [ ] Lindqvist and Delacroix arrive only if you approve them in `npm run review`.
