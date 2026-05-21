# CapStack

A multi-company cap table & scenario tool. Bridges the gap between Carta and stakeholders:
drop in a fresh Carta export, configure round assumptions, plan option grants, run scenarios.

## Status

v0.1 MVP — feature scope:

- Multi-company workspaces
- Import Carta `.xlsx` pro-forma cap tables
- Stakeholder × share-class view
- Convertible-note ledger
- Key assumptions editor with live round math (price/share, new shares, CN conversion, post-money FDS)
- Option pool + grants ledger
- Scenario modeller — clone, vary raise / pre-money / pool, see dilution & exit-value

## Run

```bash
cd capstack
npm install
npm run dev   # http://localhost:3100
```

Standalone Nuxt 4 app. Persistence: local SQLite at `data/capstack.db`.
