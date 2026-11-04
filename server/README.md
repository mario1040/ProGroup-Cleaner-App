# Naris Ops — PostgreSQL migration and API

This branch moves the application data layer from browser-side Firestore access to a PostgreSQL-backed HTTP API. The frontend uses `src/lib/api-postgres.ts`; the original Firebase adapter is retained in the repository as a reference/rollback artifact but is not imported by the active application entry points. Do not remove the source Firestore project until the migration, reconciliation, and production cutover have been signed off.

## Architecture

- React/Vite frontend calls the Express API using same-origin `/api` routes.
- Express API connects to a dedicated PostgreSQL database named `naris_ops`.
- Cloudinary remains the image host. PostgreSQL stores task/SOP image URLs and the original metadata in JSONB.
- The importer keeps an archival copy of every exported top-level Firestore document in `firestore_documents`, while populating normalized tables for application queries.
- Firebase must remain available as the source/rollback until production data has been reconciled and the new system has passed live acceptance tests.

## Safety boundary

The API, importer, and task generator validate the target database name and accept only `naris_ops`. Do not point these tools at `marketing_ops`, `evolution`, or any other existing database. Use a dedicated least-privilege PostgreSQL role for the application; do not use the PostgreSQL superuser as the runtime account.

## Database schema

Apply the schema to the dedicated database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql
```

The schema contains normalized operational tables for users, sessions, locations, zones, SOP items, task instances, operational tasks, device switches, KPI snapshots, audit logs, and task-generation runs. The generic `firestore_documents` archive preserves source fields and documents not yet represented by dedicated relational columns. Legacy template/SOP references remain text where the source audit found historical orphan references; the importer does not invent replacement relationships.

User password records are stored only in the server-side `users.password_record` column. They are removed from the JSON archive and public API responses. The importer validates the existing salted SHA-256 format and rejects plaintext records.

## Firestore backup import

The importer consumes the REST backup directory created in Cloud Shell. It supports a read-only dry run and page-level idempotent imports.

```bash
npm install --legacy-peer-deps
npm run data:import-firestore -- --dry-run --backup-dir "$HOME/naris_ops_firestore_backup"
```

Review collection counts, duplicate usernames, required fields, relationship warnings, and password-format audit before importing. Then, only after the target database has been independently verified:

```bash
npm run data:import-firestore -- --backup-dir "$HOME/naris_ops_firestore_backup"
```

The existing verified export contains 2,920 top-level documents across 10 collections. It is not a point-in-time Firestore snapshot and does not, by itself, prove Firebase Auth, subcollections, Storage objects, security rules, or indexes have been migrated. Re-export and reconcile during a final write freeze before cutover.

## HTTP API

Start the API after setting server-only environment variables:

```env
DATABASE_URL=postgresql://APP_USER:APP_PASSWORD@POSTGRES_HOST:5432/naris_ops
API_PORT=4000
PG_POOL_MAX=10
PG_SSL=false
APP_TIME_ZONE=Africa/Cairo
APP_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
SESSION_COOKIE_SAMESITE=Lax
```

```bash
npm run start:api
```

Implemented routes:

- Health: `GET /health/live`, `GET /health/ready`.
- Auth: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- Users: list, create, update, reset password, and reassign pending tasks from an inactive cleaner.
- Zones: list, create, and update; locations are read-only.
- SOPs: list, create, update, and delete.
- Tasks: date/range list, create, update lifecycle/photo fields, supervisor approve, and reject/create rework.
- Operational tasks and device switches: authenticated read-only routes.
- KPI: calculated summaries and stored KPI snapshot reads.
- Audit logs and system validation: authenticated reads.

The API uses opaque random session tokens; only token hashes are stored in PostgreSQL. Cookies are HTTP-only, have a 12-hour lifetime, and are revocable. SameSite defaults to Lax. Configure the production origin allowlist and HTTPS before deployment. Do not expose `DATABASE_URL`, password records, or Cloudinary API secrets to the browser.

## Daily recurring-task generation

The generator uses the same recurrence and assignment policy as the existing app: active SOPs only; configured scheduled times; Arabic weekday recurrence; default SOP assignee, then zone responsible employee, then least-loaded active cleaner. It intentionally does not add shift/work-day filtering that the source implementation did not have.

The API process checks the current business date at startup and every 60 seconds. It generates the day's recurring tasks once a successful run exists. Generation uses a transaction, a per-date advisory lock, deterministic task IDs, and a uniqueness index to protect against duplicate tasks across concurrent API instances. Failed runs are logged and retried on a later check.

Manual one-off generation remains available:

```bash
npm run tasks:generate
npm run tasks:generate -- 2026-11-04
```

## Photo handling

The frontend uploads photos directly to Cloudinary using an unsigned upload preset, then saves the resulting secure URL and available capture metadata with the task. Configure only the Cloudinary cloud name and unsigned preset in frontend build variables. Never place the Cloudinary API secret in frontend variables. Server-side signed deletion/cleanup and durable public-ID reconciliation remain a separate operational follow-up; the current client does not delete Cloudinary assets.

## Verification

CI runs against an ephemeral PostgreSQL 17 service and performs:

1. Schema application and smoke checks.
2. Task-engine unit tests.
3. PostgreSQL HTTP integration tests for login/session, role restrictions, task lifecycle/photo requirements, supervisor approval/rework, KPI output, SOP/user creation, system validation, and idempotent recurring-task generation.
4. TypeScript check.
5. Frontend production build.

Local commands:

```bash
npm test
npm run lint
npm run build
```

## Cutover checklist — do not skip

1. Provision a separate `naris_ops` database on the chosen PostgreSQL server without modifying existing databases.
2. Apply schema and verify health/readiness.
3. Re-run the Firestore backup export after a controlled write freeze; preserve and verify the encrypted backup hash.
4. Run importer dry-run, import into `naris_ops`, and reconcile counts and relationships.
5. Migrate the 384 Base64 photo appearances to Cloudinary safely; reconcile every URL and retain a rollback copy. The number 384 is appearances, not unique assets.
6. Verify all five users can authenticate, roles are correct, and no password values appear in API payloads/logs.
7. Compare generated tasks for the same dates against Firestore, including every recurrence frequency and multiple scheduled times.
8. Run acceptance tests on phones/tablets for cleaner and supervisor workflows, including poor connectivity and photo upload failures.
9. Verify KPI definitions against known source calculations and audit-log coverage.
10. Route production traffic only after sign-off. Keep Firebase intact and available for rollback until the agreed observation period ends.

This branch and CI do not create a database on the user's Windows/Docker host, deploy containers, configure DNS/TLS, or perform production cutover. Those steps are deliberately deferred until the code and data validation are approved.
