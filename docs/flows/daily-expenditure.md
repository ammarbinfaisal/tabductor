# Worked flow — daily expenditure update from Gmail, 07:00

The canonical "real mode" workflow (U3a): a **browser node** reads Gmail in your own
logged-in Chrome on a cron, emits one event per receipt, and an **asset node** turns the
day's events into a deliverable. No Gmail API, no OAuth app, no MCP server — the browser
node *is* the integration, which is the product's premise (§1).

## Prerequisites

1. `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in `.env` — check `/status` lists
   `browser:ai` and `asset:ai` (and `tool python.run` if you want the spreadsheet variant,
   which needs `PYRUNNER_URL`).
2. `HARNESS_NAV_ALLOWLIST=mail.google.com,accounts.google.com,google.com,localhost` in
   `.env` — the navigation guard blocks everything unlisted.
3. A Chrome with your Google session, exposed over CDP and added under the workflow's
   **Settings → Browser endpoints** (`infra/README.md`, "Driving your own browser").

## The graph

**Events**

- `expense.found` — *"One receipt or charge found in today's email: merchant, amount as a
  number, ISO currency code, ISO date, and the email subject it came from."* Publish
  compiles that description into the packet schema; nothing is hand-written.
- `expenditure.updated` — *"The daily expenditure report was produced: the asset reference
  of the report file and the day's total as a number."*

**Node 1 — `gmail-scan`, kind `browser`, mode `ai`**

After its first clean run the engine compiles this node's trace into a static script and runs
that from then on — no model calls until Gmail's layout changes, at which point the script
hands the run back to the agent mid-run and recompiles from the recovery. Nothing to
configure: `ai` is the only real mode, and `compiled` is what the engine makes of it.

- Schedule: cron `0 7 * * *`, your tz. Missed policy `skip` (never replay a backlog of
  mornings against a live site), overlap `skip`.
- Emits: `expense.found`.
- Prompt: *"Open https://mail.google.com. Search for receipts, orders, invoices and payment
  confirmations received in the last 24 hours (query: `newer_than:1d (receipt OR invoice OR
  \"order confirmation\" OR payment)`). For every distinct charge found, emit one
  `expense.found` with merchant, amount, currency, date and subject. Use the email's own
  currency; do not convert. If nothing is found, finish without emitting."*

**Node 2 — `daily-report`, kind `asset`**

- Consumes: `expense.found`. Emits: `expenditure.updated`.
- Mode `ai`: prompt it to append each expense to the workflow store
  (`store.upsert`) and write/refresh `reports/expenditure-<date>.md` via `assets.write`,
  emitting `expenditure.updated` once done.
- Or, in the same `ai` mode, ask for a spreadsheet: *"keep `reports/expenditure.xlsx` up to
  date with one row per expense"* — the node reads the current file with `assets.read`, writes
  and runs a short `openpyxl` program through `python.run` (always on its registry; needs
  `PYRUNNER_URL` on the engine), and emits `expenditure.updated` with the returned asset ref.
  There is no separate mode to pick and no program to author.

Note the fan-in shape: `daily-report` runs once **per `expense.found` event**, not once per
morning — per-task `parallelism: queue` serializes them. If you want one run per day
instead, put a decision node between: it consumes `expense.found`, and emits a single
`day.summarized` batch event the asset node consumes.

## Try it without waiting for 07:00

**Trigger now** on `gmail-scan` starts the same chain by hand — a manual start is an event
source exactly like a schedule fire. Watch the run inspector: navigations to
`mail.google.com`, `llm` rows, then `expense.found` packets in the event feed and the
asset under the workflow's assets.
