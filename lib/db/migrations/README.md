# lib/db/migrations

- Hand-written, idempotent PostgreSQL migrations for deployments without `drizzle-kit` access.
- Apply with: `psql $DATABASE_URL -f lib/db/migrations/0007_phase6_sms_geo_fraud.sql`
- The canonical source of truth is `lib/db/src/schema/*.ts`; `drizzle-kit push` remains a valid alternative.
