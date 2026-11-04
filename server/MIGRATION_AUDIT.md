> **Historical baseline note (2026-11-04):** Sections below originally recorded the pre-cutover state before PR #5 and PR #6. The current, superseding status and remaining acceptance gates are documented in the "Superseding parity review" section at the end. Do not treat older statements about the active Firebase frontend as current.

# Naris Ops migration audit — 2026-11-04

## Executive status

**Not production-ready. Do not merge, deploy, or cut over yet.** The branch is a useful foundation, not a completed migration. Firebase remains the active application data layer. No production database was contacted or changed by this review.

Target architecture agreed for this project:
- A dedicated PostgreSQL instance/container and database named `naris_ops`.
- Existing `marketing-postgres` / `marketing_ops` and `evolution_postgres` remain untouched.
- Cloudinary remains the media object store; PostgreSQL stores media URLs, public IDs, MIME types, sizes and capture/upload metadata.
- Firebase remains available until parity checks and acceptance tests pass.

## Repository and PR state

- Repository: `mario1040/ProGroup-Cleaner-App`
- Working branch: `feat/postgres-task-engine`
- PR #1: open, draft, not merged.
- Reviewed head before this audit: `b3c5cb66758934de7a67c570a644909ac787f8de`.
- Existing branch files add a pure task planner, transactional generator, first PostgreSQL schema, Firestore REST-backup importer and a partial Express API.
- CI had passed for the reviewed head. Any later commit must be rechecked independently.

## Confirmed source-system inventory

The verified REST backup contains 2,920 top-level documents across 10 collections:

| Collection | Documents |
|---|---:|
| audit_logs | 747 |
| device_switches | 57 |
| kpi_snapshots | 2 |
| locations | 1 |
| operational_tasks | 6 |
| sop_items | 38 |
| task_instances | 2,014 |
| task_templates | 40 |
| users | 5 |
| zones | 10 |
| **Total** | **2,920** |

Password audit from the backup: 5 salted SHA-256 records, 0 plaintext records, 0 missing records. Never log, display, export to generic JSON, or share password values.

Media audit: Cloudinary URLs are present, and legacy task photo fields also contain Base64 data URIs (188 after-photo and 196 before-photo appearances in the audited backup). These are appearances, not unique objects. A secure Cloudinary migration/reconciliation step is still required before relying on URL-only records.

Relationship audit highlights:
- All 10 zone location references and responsible-employee references matched.
- All 57 device-switch zone references and all 38 SOP zone references matched.
- Task assigned_to/assigned_by references matched all 2,014 task records.
- Only 1,384 task records matched current SOP IDs; 576 SOP references did not match.
- Only 617 task records matched current template IDs; 1,397 template references did not match.
- Three rework tasks have legacy template references but no SOP match.
- Preserve unmatched legacy IDs as text; do not force foreign keys or auto-map by task_code without a reviewed mapping.

The backup was validated for JSON parsing, page checkpoints, IDs, duplicate IDs and SHA-256 manifest. It is not a point-in-time snapshot and does not prove restore correctness. The documented REST backup is top-level only; Firestore subcollections, Firebase Auth, Storage, deployed rules and indexes need separate inventory/verification. A final fresh backup is required during a controlled freeze before cutover.

## Current implementation review

### Implemented foundation
- Pure recurrence planner with unit tests.
- Transactional daily task generator with a per-date advisory lock, deterministic IDs and conflict-safe inserts.
- Importer preserving Firestore document paths and source data in `firestore_documents`, plus normalized tables for users, locations, zones, SOPs and task instances.
- User password record stored separately from user `raw_data` and generic archive JSON.
- Initial session-based API: login/logout/me, health, users, zones, SOP items and task reads.
- CI workflow for tests, TypeScript and frontend build.

### Critical gaps — must be completed before production
1. **Frontend still uses Firebase directly.** `src/lib/api.ts` imports Firebase Auth, Firestore and Firebase Storage; `App.tsx` restores sessions by querying Firebase. The new API is not the app's active adapter.
2. **API coverage is incomplete.** Missing production endpoints/transactions for profile CRUD, zones/SOP CRUD, task create/update/start/complete, photo metadata, supervisor approve/reject/rework, operational tasks, device switches, KPI, audit logs and relevant notifications.
3. **No API integration tests.** Current tests cover pure recurrence/assignment/idempotency planning; they do not exercise HTTP auth, RBAC, PostgreSQL transactions, concurrent generator runs, importer restore or task lifecycle.
4. **No full schema for all operational entities.** Archive records exist, but normalized access and indexes for operational_tasks, device_switches, kpi_snapshots and audit_logs are not complete.
5. **No verified Cloudinary transfer for Base64 photos.** Do not expose Cloudinary secrets to Vite/browser code or request them in chat. Migration must run server-side using environment secrets and produce a reconciliation report.
6. **No live parity test.** Compare same-date Firebase and PostgreSQL generated plans, existing task states, assignment outcomes, KPI calculations and photo availability before any traffic switch.
7. **No scheduler deployment.** The task generator must remain disabled until parity is accepted. Never let Firebase and PostgreSQL generators create the same production day's tasks concurrently.
8. **No deployment/recovery runbook.** Need Docker Compose, health checks, persistent volume, least-privilege DB role, backups, restore drill, log rotation, secret handling and rollback procedure.
9. **No full Firestore export proof.** Reconcile all source collections, subcollections, Firebase Auth identities, Storage objects, rules and indexes. Repeat export during a write freeze.
10. **Legacy references need an explicit policy.** Preserve unmatched IDs; don't cascade-delete or invent replacements.

## Compatibility notes for the recurring task engine

The current Firestore generator behavior in `src/lib/api.ts` is the baseline:
- Active SOPs only.
- `scheduled_times`, else `scheduled_time`, else 09:00.
- Daily and three-times-daily frequencies create one task per configured time.
- Every-other-day recurrence anchors on SOP `created_at`, with legacy fallback 2026-07-01.
- Weekly recurrence uses configured Arabic weekdays.
- Assignment order: active cleaner SOP default assignee, then active cleaner zone responsible employee, then least number of tasks assigned for that date; ties by employee ID.
- Generated IDs retain `ti_rec_<sopId>_<YYYY-MM-DD>_<index>`; the legacy first-occurrence ID is recognized.
- The current baseline does not filter by work_days or shift hours; do not add those constraints silently.
- Existing code uses `p1` as `assigned_by` for recurring generated tasks. Preserve until product owner explicitly changes this policy.

## Security and reliability review of the initial API

Improvements applied in this audit commit:
- SameSite=Lax is now the default session cookie policy; cross-site SameSite=None requires explicit configuration and production HTTPS.
- Production state-changing requests require an allowed Origin header.
- Added baseline security response headers.
- Bounded stale login-throttle entries to avoid unbounded growth.
- Readiness checks verify required tables exist, not just that PostgreSQL responds.
- Task date-range validation now requires both endpoints, rejects reversed ranges and caps ranges at 366 days.
- Graceful SIGTERM/SIGINT shutdown closes the HTTP server and PostgreSQL pool.

Still required:
- Decide whether deployment is same-site or cross-site and configure `APP_ALLOWED_ORIGINS` / `SESSION_COOKIE_SAMESITE` accordingly.
- Move rate limiting to a shared store (e.g. PostgreSQL/Redis) before horizontal scaling; in-memory throttling is per process.
- Add CSRF/security integration tests and test behind the actual reverse proxy.
- Add session cleanup/expiry maintenance and operational monitoring.
- Review proxy/IP handling before enabling trusted proxy headers.
- Use a dedicated least-privilege PostgreSQL role; never use the postgres superuser for the app.

## Acceptance gates

Do not mark migration complete until every gate is evidenced:
- [ ] Fresh source backup with collection/subcollection/Auth/Storage inventory and checksum verification.
- [ ] Restore drill into a disposable PostgreSQL instance.
- [ ] Imported counts and field-level reconciliation match expected source data.
- [ ] Password login works against all imported salted records; no password values exposed.
- [ ] Every API route has RBAC, input validation, audit behavior and integration tests.
- [ ] All frontend Firebase reads/writes/listeners/auth/storage paths are replaced or intentionally retained with a documented reason.
- [ ] Task lifecycle, photo flow, approvals, rework, KPI and audit outputs match Firebase baseline.
- [ ] Same-date generator comparison passes with no duplicates or unexplained assignment differences.
- [ ] Cloudinary Base64 migration reconciles every legacy media reference.
- [ ] Docker health, persistence, backup/restore and rollback drills pass.
- [ ] User acceptance sign-off before production cutover.
- [ ] Firebase is retained read-only/rollback-ready for an agreed observation period.

## Current decision

Continue implementation on this branch only. Keep PR #1 draft. Do not create or connect the new PostgreSQL container yet, do not run the importer against an existing database, do not enable the scheduler, and do not remove Firebase.

## Implementation update — 2026-11-04

The branch now also includes:
- A strict connection guard used by API startup, the importer and task scheduler. It accepts only the database path `/naris_ops`; attempts to target `marketing_ops`, Evolution, or another database fail before opening a connection.
- Automated tests for accepted/rejected database targets, and CI now runs all server tests.
- Normalized tables and importer upserts for `operational_tasks`, `device_switches`, `kpi_snapshots` and `audit_logs`, while retaining each source document in the generic archive table.
- Read-only API endpoints for locations, operational tasks, device switches, KPI snapshots and audit logs, with role scoping for operational tasks and cleaner-specific KPI/audit visibility.
- Task reads now have validated calendar dates, a maximum 366-day range and bounded pagination.
- Readiness checks include the newly normalized tables.

CI run `41803408830` for commit `6b5ae191e95e47b72325662a7ad2c04e1cad044f` completed successfully: server tests, TypeScript check and frontend production build all passed.

These additions do **not** complete the migration. The frontend still calls Firebase; task mutations and lifecycle routes are not implemented; API integration tests and restore/parity tests remain absent. Keep the PR draft and Firebase active.


## Superseding parity review — 2026-11-04

### Current repository state after PR #5 and PR #6
- The active frontend entry point and all reviewed data-using components import `src/lib/api-postgres.ts`.
- The Firebase SDK dependency, Firebase client adapter, client initializer, quota manager, Firebase app config, Firestore/Storage rules, indexes and Firebase deployment config were removed from the active repository.
- Repository source scan found only `server/import-firestore-backup.ts` under Firebase/Firestore-named paths. It is a one-time offline importer for an exported backup; it does not connect to Firebase.
- `firestore_documents` is a PostgreSQL archive of imported source documents, not a live Firebase connection.
- The actual deployed application has not been verified from this GitHub-only review. Deployment and live DB checks remain separate acceptance gates.

### Source collection to PostgreSQL mapping
| Source collection | PostgreSQL operational table | Status |
|---|---|---|
| users | users | Implemented; password records stored separately |
| locations | locations | Implemented |
| zones | zones | Implemented |
| sop_items | sop_items | Implemented; recurring scheduler reads this table |
| task_templates | task_templates | Merged in PR #7; targeted importer support included |
| task_instances | task_instances | Implemented; task lifecycle and metadata stored in JSONB plus indexed columns |
| operational_tasks | operational_tasks | Implemented; read API |
| device_switches | device_switches | Implemented; read API |
| kpi_snapshots | kpi_snapshots | Implemented; read API |
| audit_logs | audit_logs | Implemented; write audit events and read API |

Additional PostgreSQL-owned entities:
- `auth_sessions` replaces browser session handling; `users.password_record` authenticates the imported application accounts.
- `task_media` (PR #7) stores relational metadata for task photos; the actual image objects remain in Cloudinary, not PostgreSQL.
- `inventory_items` is a new PostgreSQL-backed feature, not one of the ten collections in the source backup.
- `firestore_documents` retains source JSON and document paths for audit/rollback.

### Merged PR #7 parity work
Merged PR #7 adds:
- A distinct `task_templates` table and CRUD API; it is no longer aliased to `sop_items`.
- Importer support for normalizing `task_templates`, and `--only-collection` to import that collection without overwriting active task records.
- Preservation of an existing PostgreSQL password record when a source backup is re-imported.
- `task_media` metadata persistence for task photo URLs, Cloudinary public IDs, MIME types, sizes and capture/upload timestamps.
- Authenticated server-side Cloudinary deletion; API secrets are server-only.
- A resumable, dry-run-first media reconciliation command that uploads Base64 and non-Cloudinary task photo URLs to Cloudinary and indexes their metadata.
- A validation endpoint that compares each source archive collection count with its normalized table count and reports missing normalized records. Extra rows created by the application after migration are allowed.

### Remaining gaps — do not declare Firebase retired yet
1. **The current REST backup is top-level only.** Firestore subcollections are not proven exported or reconciled.
2. **Firebase Auth is not proven reconciled.** The backup includes five application user records with salted password hashes, but does not prove every Firebase Auth identity, UID, provider, disabled state or identity mapping was included. Validate the source Auth user list separately.
3. **Firebase Storage is not proven fully inventoried.** The backup audit counted 384 Base64 photo-field appearances (not unique files). The new Cloudinary migration script has not been run against the live database, and unreferenced Storage objects are not covered by task-field migration.
4. **Other image fields** (for example user avatars, zone cover images, template guide/reference images and signatures) need a source-side inventory and URL/provider reconciliation; task photo migration alone is not proof for every Storage object.
5. **The ten collection parity check** requires the source archive to be present in `firestore_documents` and the targeted `task_templates` import to have run. It is not a substitute for field-level comparison or subcollection/Auth/Storage inventory.
6. **Task engine parity and scheduler cutover** remain disabled until same-date plan, assignment and existing-task-state reconciliation is accepted. Keep `TASK_GENERATION_ENABLED=false`.
7. **Live deployment** still requires migration, importer, readiness, login, task lifecycle, photo, approvals, KPI, audit, inventory persistence, backup/restore and rollback tests on the actual Naris server.

### Safe next operations after PR #7 merge
1. Back up the current `naris_ops` database and confirm the Firestore backup directory is present.
2. Run a dry-run of the targeted `task_templates` import, then apply only that collection. Do not re-import all task collections over live operational data.
3. Run the Cloudinary media migration in dry-run mode; review the number of Base64 and Firebase Storage URLs. Configure the server-side Cloudinary upload preset before applying.
4. Apply media migration in a controlled window and rerun it to confirm `remaining_base64_tasks=0` and `remaining_firebase_url_tasks=0` for task photo fields. Dry-run output separately reports planned Base64 uploads, external URL uploads, and existing Cloudinary metadata indexing.
5. Run `/api/system/validation` and resolve every error; inspect warnings for unmatched legacy SOP/template references and media.
6. Complete source-side Firebase Auth, subcollection and Storage inventory, then perform user acceptance and rollback drills before retiring the Firebase project.

**Current decision:** The application code has been switched away from Firebase, but full data/service parity and live production cutover are not yet evidenced. Keep the Firebase project available read-only/rollback-ready until all remaining gates pass.
