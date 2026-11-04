# Naris Ops PostgreSQL Task Generator

This is the first isolated backend slice for the Firestore-to-PostgreSQL migration. It does not modify the existing React app or write to Firebase.

## Compatibility rules implemented

The planner mirrors the current recurring-task behavior in `src/lib/api.ts`:

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

Apply `server/db/schema.sql` to the dedicated PostgreSQL database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql
```

The schema keeps source document IDs and raw Firestore documents in `raw_data`. Legacy template/SOP references remain text rather than strict foreign keys because the live audit found historical references that do not match current master records.

## Run once

Install the added dependencies and configure `DATABASE_URL`:

```bash
npm install
npm run tasks:generate
npm run tasks:generate -- 2026-11-04
```

The default date is calculated in `APP_TIME_ZONE` (defaults to `Africa/Cairo`).

## Scheduling

Run this command once daily from the host scheduler after database import is validated. Example cron (03:00 Cairo server time):

```cron
0 3 * * * cd /path/to/ProGroup-Cleaner-App && npm run tasks:generate >> /var/log/naris-task-generator.log 2>&1
```

Do not enable this cron against production until the migrated data has been imported and the generated plan has been compared with Firebase for the same date.

## Safety

- Generation runs in a PostgreSQL transaction and uses a per-date advisory lock.
- Deterministic IDs plus a unique recurring-occurrence index protect against duplicate generation.
- It writes only recurring tasks; rework and one-time tasks are outside this generator.
- Every attempt is recorded in `task_generation_runs`.
- No Firebase records are modified.
