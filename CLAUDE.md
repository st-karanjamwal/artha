# Artha: rules for Claude Code

Master plan: [docs/PLAN.md](docs/PLAN.md). Status: Phases 0, 1 and 2 (mutual funds, spec in docs/modules/MUTUAL_FUNDS.md) are done; next is Phase 3 (insurance).

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
- Mutual funds: units/NAV are INTEGER micro-units via `src/lib/units.ts` (decimal.js); never multiply
  money in SQL; holdings are derived from `MFTransaction` (no holdings table). MF tables are singular
  and use `Status` instead of `IsActive`, as the owner specified.
- Business logic lives in `frontend/src/repositories/*.ts` (sync functions over sql.js).
  Components call them through `useDb(() => …, deps)`.

## Commands

```bash
cd backend && .venv/bin/pytest -q && .venv/bin/ruff check .
cd frontend && npm test && npm run lint && npx tsc --noEmit && npm run e2e
```
