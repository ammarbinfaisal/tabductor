# Example: daily expenditure

Intent: “Each morning, collect new card transactions from the bank portal, categorize them,
remember what was processed, and flag unusual spending.”

One possible internal graph is:

```text
Browser: retrieve transactions
  emits transaction.raw
        ↓
Decision: normalize, categorize, and upsert transactions
  emits expenditure.flagged when needed
```

The workflow store contains a `transactions` table keyed by the provider transaction id and an
optional `category_rules` table. The decision queries existing ids, upserts normalized rows, and
emits only new anomalies. The browser never performs category semantics or store work.

After enough runs, frequent browser deopts or repeated parsing can cause the Graph Optimizer to
propose a narrower retrieval browser task plus a dedicated normalization decision. That graph
change and any new normalized table are one candidate publication.
