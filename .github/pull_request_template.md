## What & why

<!-- One or two sentences: what changed and the reason. -->

## Checklist

- [ ] **Verification ladder ran green** — typecheck (backend/worker/frontend), `STRICT=1` smoke suite, and Playwright e2e if the frontend changed.
- [ ] **Docs rectified** — CLAUDE.md (contracts/invariants/endpoints/gotchas) and README (architecture/data model/pages/verification) match this diff — **or** the line below says why not.
- [ ] **Hand-synced pairs changed in pairs** — scan types, unit tables, nutrition scaling, smoke twins, model pools (see CLAUDE.md "Critical gotchas") — or none were touched.
- [ ] **Schema changes are idempotent** in `db/schema.sql` *and* the PR notes the manual `ALTER` needed on a running DB — or no schema change.
- [ ] **New API contracts have smoke assertions in both twins** — or no new contracts.

**No doc update needed because:** <!-- delete if docs were updated -->
