# Naris Ops PostgreSQL Migration Foundation

This is an isolated backend foundation for the Firestore-to-PostgreSQL migration. The existing React app and Firebase production data are not modified by these tools.

## Current task-generator compatibility

The planner mirrors the recurring-task behavior in `src/lib/api.ts`:

1. Only active SOP items are considered.
2. `scheduled_times` wins; otherwise `scheduled_time`; otherwise `09:00`.
3. Daily and three-times-daily frequencies create one occurrence per configured time.
4. Every-other-day uses the SOP `created_at` date as its anchor (legacy fallback: `2026-07-01`).
5. Weekly frequencies use the Arabic weekday in `recurrence_days`.
6. Assignment priority is default SOP assignee, then zone responsible employee, then least task count for that date.
7. Only active users with role `cleaner` are eligible.
8. Workload ties are resolved by employee ID.
9. IDs retain the existing `ti_rec_<sopId>_<YYYY-MM-DD>_<index>` format and the legacy no-index ID is recognized for the first occurrence.

The old generator does not filter by `work_days` or shift times, so this compatibility implementation intentionally does not silently change that policy.

## Database setup

Create/use a dedicated PostgreSQL database (for example, `naris_ops`) and apply the schema:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql
```

The schema includes:
- `firestore_documents`: archival mirror for all source collections, including collections not yet normalized.
- normalized `users`, `locations`, `zones`, `sop_items`, and `task_instances` tables for the first backend slice.
- `task_generation_runs` for generator execution history.

Firestore document IDs are preserved. Legacy template/SOP references remain text rather than strict foreign keys because the live audit found historical references that do not match current master records.

User password records are kept in the server-only `users.password_record` column. They are excluded from `raw_data` and from the generic archive table. The importer recognizes the existing salted SHA-256 format without printing any password values. It blocks import if plaintext password records are found; rotate those credentials in the source system before retrying.

## Firestore backup import

The importer reads the existing REST backup directory created in Cloud Shell. It is page-based and idempotent, so it can be rerun safely after a failed page.

First run a read-only validation (no database connection or writes):

```bash
npm install --legacy-peer-deps
npm run data:import-firestore -- --dry-run
```

If the backup is stored elsewhere:

```bash
npm run data:import-firestore -- --dry-run --backup-dir "$HOME/naris_ops_firestore_backup"
```

Review the aggregate counts, duplicate-username check, and password-format audit. Do not share the backup files or user records in chat.

After the dry run is clean and the PostgreSQL database is ready:

```bash
npm run data:import-firestore
```

The import stores all top-level collections in `firestore_documents`. It additionally populates the five normalized tables used by the task engine. Other collections remain safely preserved in the archive table until their normalized schemas and APIs are implemented.

## Run the recurring task generator

Configure server-only variables in `.env`:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/naris_ops
APP_TIME_ZONE=Africa/Cairo
```

Then run:

```bash
npm run tasks:generate
npm run tasks:generate -- 2026-11-04
```

The default date is calculated in `APP_TIME_ZONE` (defaults to `Africa/Cairo`).

## Scheduling

Run the generator once daily from the host scheduler only after import validation and a same-date comparison against Firebase. Example cron (03:00 Cairo server time):

```cron
0 3 * * * cd /path/to/ProGroup-Cleaner-App && npm run tasks:generate >> /var/log/naris-task-generator.log 2>&1
```

Do not enable this cron against production until the migrated data has been imported and the generated plan has been compared with Firebase for the same date.

## Safety

- The importer uses one transaction per backup page and upserts by original Firestore document path.
- User password values are excluded from generic JSON archives and are never printed.
- Generation runs in a PostgreSQL transaction and uses a per-date advisory lock.
- Deterministic IDs plus a unique recurring-occurrence index protect against duplicate generation.
- The generator writes only recurring tasks; rework and one-time tasks are outside this generator.
- Every generation attempt is recorded in `task_generation_runs`.
- Neither importer nor generator writes to Firebase.


## HTTP API foundation (first backend slice)

The branch now includes `server/http.ts` and the `start:api` script.

Implemented endpoints:

- `GET /health/live`: process liveness.
- `GET /health/ready`: verifies PostgreSQL connectivity.
- `POST /api/auth/login`: verifies the existing salted SHA-256 password record and creates a server-side session.
- `POST /api/auth/logout`: revokes the current session.
- `GET /api/auth/me`: returns the authenticated profile without password fields.
- `GET /api/users`: admin/supervisor profile listing.
- `GET /api/zones`: authenticated zone listing.
- `GET /api/sop-items`: admin/supervisor SOP listing.
- `GET /api/tasks?date=YYYY-MM-DD`: task listing; cleaners are restricted to their own assigned tasks. Admins and supervisors can see all tasks.

Security foundation:

- Random opaque session tokens; only SHA-256 token hashes are stored in `auth_sessions`.
- HTTP-only session cookie, 12-hour expiry, and server-side revocation.
- Login attempt throttling by source IP.
- CORS origin allowlist via `APP_ALLOWED_ORIGINS`.
- Production write requests require an allowlisted `Origin`; session cookies default to `SameSite=Lax` (`SESSION_COOKIE_SAMESITE=None` is allowed only over production HTTPS for a deliberately cross-site deployment).
- `/health/ready` verifies the required core tables exist; task date ranges require both endpoints and are capped at 366 days.
- Password records are never returned by API profile endpoints.
- Database errors and SQL details are not returned to clients.

Start locally after applying `server/db/schema.sql` and configuring the server-only `.env`:

```bash
npm run start:api
```

This is an initial API slice, not yet a complete frontend cutover. The current React application still calls Firebase directly. Task mutations (start/complete/photo upload/approval/rework), full metadata CRUD, KPI/audit endpoints, and the frontend API adapter must be completed and tested before switching production traffic. Do not enable the PostgreSQL scheduler or remove Firebase during this phase.
