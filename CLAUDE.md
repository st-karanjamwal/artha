# Artha: rules for Claude Code

Master plan: [docs/PLAN.md](docs/PLAN.md). Status: Phase 0 and Phase 1 are done; next is Phase 2 (mutual funds).

## Non-negotiables (plan §16)

1. Never send plaintext financial data or keys to the backend; it handles opaque blobs only.
2. Money is INTEGER paise everywhere; format only at the UI edge (`formatINR`, `en-IN`, ₹).
3. All schema changes go in a new `frontend/src/db/migrations/NNN_description.sql`. Never edit an
   applied migration.
4. Secret fields use the `*_Enc` suffix, `encryptSecret()` from `src/crypto/secrets.ts`, and the
   `<SecretField>` component. Never log them.
5. Write tests for crypto, migrations, money math and balance calculations before UI polish.
6. Build phase by phase; meet a phase's acceptance criteria before starting the next.
7. Keep dependencies minimal: no runtime CDNs, analytics or telemetry.
8. Mobile-first: every list screen must work on a phone.
9. Ask the owner before changing the security model, vault file format or conventions in the plan.

## Conventions

- Tables PascalCase plural; columns PascalCase; PK `<Entity>Id INTEGER PRIMARY KEY AUTOINCREMENT`.
- Master tables have `CreatedOn`/`UpdatedOn` (UTC ISO) and `IsActive` (soft delete); `Notes TEXT`.
- Business dates are local `YYYY-MM-DD` text.
- New "type" lists go in `LookupValues` (and `LookupCategory` in `repositories/lookups.ts`).
- Business logic lives in `frontend/src/repositories/*.ts` (sync functions over sql.js).
  Components call them through `useDb(() => …, deps)`.

## Commands

```bash
cd backend && .venv/bin/pytest -q && .venv/bin/ruff check .
cd frontend && npm test && npm run lint && npx tsc --noEmit && npm run e2e
```
