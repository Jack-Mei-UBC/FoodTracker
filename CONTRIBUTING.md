# Contributing

Thanks for taking a look! This repo runs a fairly disciplined development loop —
most of it is automated, so the main thing to know is what the automation
expects of you.

## Setup

Requires Docker. Copy the env template and boot the stack:

```bash
cp .env.example .env            # fill in OPENROUTER_API_KEY / FDC_API_KEY if you want OCR / USDA lookup
docker compose up -d --wait     # dev stack with hot reload (compose override loads automatically)
node frontend/e2e/fixtures/seed.mjs   # idempotent fixture catalog (or: cd frontend && npm run seed)
```

- UI: http://localhost:3000 · API: http://127.0.0.1:4000/api/health
- After a `package.json` change: `docker compose up -d --build -V <service>`
  (the `-V` matters — see CLAUDE.md's compose notes).

## Before you open a PR

1. **Read [CLAUDE.md](CLAUDE.md).** It's the living spec — the invariants and
   gotchas in there are the review checklist, whether you're a human or an
   agent. The big ones: some contracts are deliberately duplicated across
   languages and must change **in pairs** (each file says so in a comment);
   schema changes must be idempotent in `db/schema.sql` **and** applied to a
   running DB by hand; the frontend must stay statically exportable (no server
   code).
2. **Run the verification ladder:**
   ```bash
   # typecheck (each service)
   npx tsc --noEmit -p backend && npx tsc --noEmit -p worker && npx tsc --noEmit -p frontend
   # smoke suite against the running stack (STRICT: a down stack fails instead of skipping)
   STRICT=1 bash scripts/smoke-test.sh        # or: powershell -File scripts/smoke-test.ps1
   # UI net, if you touched the frontend
   cd frontend && npm run seed && npm run test:e2e
   ```
   CI runs the same smoke suite (`.github/workflows/smoke.yml`) in strict mode
   against the production-shaped compose stack, so a red local run will be a red
   build.
3. **Update the docs with the change.** CLAUDE.md for any new/changed contract,
   endpoint, invariant, or gotcha; README.md when the architecture / data model
   / page list / verification story changes. If your change genuinely needs no
   doc update, say so in the PR description — the omission should be a decision,
   not an oversight. (If you develop with Claude Code, a push gate enforces this
   for large diffs and a `doc-sync` agent does the rectification.)
4. **Extend the smoke tests when you add a contract** — and add the assertion to
   **both** twins (`scripts/smoke-test.ps1` and `scripts/smoke-test.sh`), or
   neither. CI-green must keep meaning hook-green.

## Conventions worth knowing

- No unit-test suite by design; the smoke twins + Playwright interaction
  contracts are the net. Extend those instead of adding a parallel framework.
- Popups go through the shared `Modal`; price/nutrition entry goes through
  `PriceEditor`/`MacroEditor`; crops through `ImageCropper`. Reuse, don't fork.
- Everything an LLM produces (OCR, meal drafts, auto-tags, merge suggestions)
  is a draft until a human approves it. Don't add an AI surface that writes
  directly.
- Commit messages: plain imperative summaries; one logical change per PR.
