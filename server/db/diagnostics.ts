import "dotenv/config";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./connection";

function getBusinessDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

/**
 * Read-only production diagnostics. Never returns password hashes, session
 * tokens, raw_data, connection strings, or personally identifying phone data.
 */
async function main(): Promise<void> {
  const connectionString = assertNarisDatabaseUrl(process.env.DATABASE_URL);
  const timeZone = process.env.APP_TIME_ZONE || "Africa/Cairo";
  const businessDate = getBusinessDate(timeZone);
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });

  try {
    const [database, users, adminAccounts, cleaners, sopFrequencies, sopWarnings,
      todayTasks, todayRuns, integrity, sourceCollections, archiveCoverage, monthlyArchive,
      sourceParity, monthlySourceParity, postImportTasksByMonth, snapshotCoverage, snapshotsByPeriod, mediaIntegrity, media] = await Promise.all([
      pool.query(
        "SELECT current_database() AS database, current_user AS runtime_role, " +
        "current_setting('server_version') AS postgres_version",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active, " +
        "COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive " +
        "FROM users",
      ),
      pool.query(
        "SELECT id, username, role, is_active, " +
        "CASE WHEN password_record IS NULL OR password_record = '' THEN 'missing' " +
        "WHEN password_record ~ '^[a-fA-F0-9]{16,}:[a-fA-F0-9]{64}$' THEN 'salted_sha256' " +
        "WHEN position(':' in password_record) > 0 THEN 'unknown_hash_format' " +
        "ELSE 'legacy_plaintext' END AS password_record_status " +
        "FROM users WHERE role = 'admin' ORDER BY username",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active " +
        "FROM users WHERE role = 'cleaner'",
      ),
      pool.query(
        "SELECT frequency, COUNT(*)::int AS total " +
        "FROM sop_items WHERE is_active = TRUE GROUP BY frequency ORDER BY frequency",
      ),
      pool.query(
        "SELECT " +
        "COUNT(*) FILTER (WHERE z.id IS NULL)::int AS missing_zone, " +
        "COUNT(*) FILTER (WHERE s.frequency IN ('أسبوعي','مرتين أسبوعيا','ثلاث مرات أسبوعيا') " +
        "AND (jsonb_typeof(s.recurrence_days) IS DISTINCT FROM 'array' " +
        "OR jsonb_array_length(CASE WHEN jsonb_typeof(s.recurrence_days) = 'array' " +
        "THEN s.recurrence_days ELSE '[]'::jsonb END) = 0))::int AS weekly_without_days, " +
        "COUNT(*) FILTER (WHERE s.frequency IN ('يوم ويوم','يوم و يوم') " +
        "AND (s.created_at IS NULL OR s.created_at::text = ''))::int AS alternate_day_without_anchor, " +
        "COUNT(*) FILTER (WHERE s.frequency NOT IN ('يومي','ثلاث مرات يوميا','يوم ويوم','يوم و يوم', " +
        "'أسبوعي','مرتين أسبوعيا','ثلاث مرات أسبوعيا'))::int AS unsupported_frequency " +
        "FROM sop_items s LEFT JOIN zones z ON z.id = s.zone_id WHERE s.is_active = TRUE",
      ),
      pool.query(
        "SELECT status, task_type, COUNT(*)::int AS total FROM task_instances " +
        "WHERE due_date = $1::date GROUP BY status, task_type ORDER BY task_type, status",
        [businessDate],
      ),
      pool.query(
        "SELECT status, COUNT(*)::int AS total, " +
        "COALESCE(SUM(generated_count),0)::int AS generated, " +
        "COALESCE(SUM(skipped_existing_count),0)::int AS skipped_existing, " +
        "COALESCE(SUM(skipped_no_assignee_count),0)::int AS skipped_no_assignee " +
        "FROM task_generation_runs WHERE run_date = $1::date GROUP BY status ORDER BY status",
        [businessDate],
      ),
      pool.query(
        "SELECT " +
        "(SELECT COUNT(*)::int FROM task_instances t LEFT JOIN sop_items s ON s.id = t.sop_item_id " +
        " WHERE t.sop_item_id IS NOT NULL AND s.id IS NULL) AS orphan_sop_references, " +
        "(SELECT COUNT(*)::int FROM task_instances t " +
        " WHERE t.template_id IS NOT NULL " +
        " AND NOT EXISTS (SELECT 1 FROM task_templates tt WHERE tt.id = t.template_id) " +
        " AND NOT EXISTS (SELECT 1 FROM sop_items si WHERE si.id = t.template_id)) AS unresolved_template_references, " +
        "(SELECT COUNT(*)::int FROM task_instances " +
        " WHERE task_type IN ('recurring','rework') AND sop_item_id IS NULL) AS recurring_or_rework_without_sop_id",
      ),
      pool.query(
        "SELECT collection_name, COUNT(*)::int AS documents " +
        "FROM firestore_documents GROUP BY collection_name ORDER BY collection_name",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total_tasks, MIN(due_date)::text AS first_due_date, " +
        "MAX(due_date)::text AS last_due_date, " +
        "COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_tasks, " +
        "COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_tasks, " +
        "COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_tasks, " +
        "COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_tasks " +
        "FROM task_instances",
      ),
      pool.query(
        "SELECT to_char(date_trunc('month', due_date), 'YYYY-MM') AS month, " +
        "COUNT(*)::int AS total, " +
        "COUNT(*) FILTER (WHERE status = 'completed')::int AS completed, " +
        "COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected, " +
        "COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, " +
        "COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress, " +
        "COUNT(*) FILTER (WHERE status = 'completed' AND LOWER(COALESCE(raw_data->>'supervisor_approved','false')) = 'true')::int AS supervisor_approved " +
        "FROM task_instances GROUP BY date_trunc('month', due_date) ORDER BY date_trunc('month', due_date)",
      ),
      pool.query(
        "WITH source AS (" +
        " SELECT document_id, MAX(imported_at) OVER () AS last_import_at " +
        " FROM firestore_documents WHERE collection_name = 'task_instances'" +
        "), source_stats AS (" +
        " SELECT COUNT(*)::int AS source_documents, MAX(imported_at) AS last_import_at " +
        " FROM firestore_documents WHERE collection_name = 'task_instances'" +
        ") SELECT (SELECT COUNT(*)::int FROM task_instances) AS normalized_tasks, " +
        "ss.source_documents, ss.last_import_at, " +
        "(SELECT COUNT(*)::int FROM task_instances t JOIN source s ON s.document_id = t.id) AS matched_imported_tasks, " +
        "(SELECT COUNT(*)::int FROM task_instances t WHERE NOT EXISTS (" +
        " SELECT 1 FROM source s WHERE s.document_id = t.id)) AS normalized_without_source, " +
        "(SELECT COUNT(*)::int FROM task_instances t CROSS JOIN source_stats x " +
        " WHERE NOT EXISTS (SELECT 1 FROM source s WHERE s.document_id = t.id) " +
        " AND x.last_import_at IS NOT NULL AND t.created_at > x.last_import_at) AS post_import_native_tasks, " +
        "(SELECT COUNT(*)::int FROM task_instances t CROSS JOIN source_stats x " +
        " WHERE NOT EXISTS (SELECT 1 FROM source s WHERE s.document_id = t.id) " +
        " AND (x.last_import_at IS NULL OR t.created_at <= x.last_import_at)) AS unmatched_created_before_or_during_import, " +
        "(SELECT COUNT(*)::int FROM firestore_documents d WHERE d.collection_name = 'task_instances' " +
        " AND NOT EXISTS (SELECT 1 FROM task_instances t WHERE t.id = d.document_id)) AS source_without_normalized, " +
        "(SELECT COUNT(*)::int FROM (SELECT document_id FROM firestore_documents " +
        " WHERE collection_name = 'task_instances' GROUP BY document_id HAVING COUNT(*) > 1) duplicates) AS duplicate_source_ids " +
        "FROM source_stats ss",
      ),
      pool.query(
        "WITH source_monthly AS (" +
        " SELECT to_char(substring(d.data->>'due_date' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')::date, 'YYYY-MM') AS month, COUNT(*)::int AS total " +
        " FROM firestore_documents d WHERE d.collection_name = 'task_instances' " +
        " AND d.data->>'due_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' " +
        " GROUP BY to_char(substring(d.data->>'due_date' from '^[0-9]{4}-[0-9]{2}-[0-9]{2}')::date, 'YYYY-MM')" +
        "), normalized_imported_monthly AS (" +
        " SELECT to_char(date_trunc('month', t.due_date), 'YYYY-MM') AS month, COUNT(*)::int AS total " +
        " FROM task_instances t JOIN firestore_documents d ON d.collection_name = 'task_instances' AND d.document_id = t.id " +
        " GROUP BY date_trunc('month', t.due_date)" +
        ") SELECT COALESCE(s.month, n.month) AS month, COALESCE(s.total,0)::int AS source_total, " +
        "COALESCE(n.total,0)::int AS normalized_imported_total " +
        "FROM source_monthly s FULL OUTER JOIN normalized_imported_monthly n ON n.month = s.month " +
        "WHERE COALESCE(s.total,0) <> COALESCE(n.total,0) ORDER BY month",
      ),
      pool.query(
        "SELECT to_char(date_trunc('month', t.due_date), 'YYYY-MM') AS month, " +
        "COUNT(*)::int AS post_import_native_tasks " +
        "FROM task_instances t " +
        "WHERE NOT EXISTS (SELECT 1 FROM firestore_documents d " +
        " WHERE d.collection_name = 'task_instances' AND d.document_id = t.id) " +
        "AND t.created_at > (SELECT MAX(imported_at) FROM firestore_documents WHERE collection_name = 'task_instances') " +
        "GROUP BY date_trunc('month', t.due_date) ORDER BY date_trunc('month', t.due_date)",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total_snapshots, MIN(period_start)::text AS first_period_start, " +
        "MAX(period_end)::text AS last_period_end, " +
        "COUNT(*) FILTER (WHERE profile_id IS NULL OR NOT EXISTS " +
        "(SELECT 1 FROM users u WHERE u.id = k.profile_id))::int AS snapshots_without_profile " +
        "FROM kpi_snapshots k",
      ),
      pool.query(
        "SELECT period_type, COUNT(*)::int AS total, MIN(period_start)::text AS first_period_start, " +
        "MAX(period_end)::text AS last_period_end " +
        "FROM kpi_snapshots GROUP BY period_type ORDER BY period_type",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS total_media, " +
        "COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM task_instances t WHERE t.id = m.task_id))::int AS media_without_task " +
        "FROM task_media m",
      ),
      pool.query(
        "SELECT storage_provider, side, COUNT(*)::int AS total " +
        "FROM task_media GROUP BY storage_provider, side ORDER BY storage_provider, side",
      ),
    ]);

    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      businessDate,
      timeZone,
      database: database.rows[0],
      users: users.rows[0],
      adminAccounts: adminAccounts.rows,
      cleaners: cleaners.rows[0],
      activeSopFrequency: sopFrequencies.rows,
      activeSopWarnings: sopWarnings.rows[0],
      todayTasks: todayTasks.rows,
      todayGenerationRuns: todayRuns.rows,
      historicalReferenceIntegrity: integrity.rows[0],
      importedFirestoreCollections: sourceCollections.rows,
      archiveCoverage: archiveCoverage.rows[0],
      monthlyArchive: monthlyArchive.rows,
      taskSourceParity: sourceParity.rows[0],
      monthlyTaskSourceParityMismatches: monthlySourceParity.rows,\n      postImportTasksByMonth: postImportTasksByMonth.rows,
      historicalKpiSnapshotCoverage: snapshotCoverage.rows[0],
      kpiSnapshotsByPeriod: snapshotsByPeriod.rows,
      taskMediaIntegrity: mediaIntegrity.rows[0],
      taskMedia: media.rows,
    }, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    "Naris diagnostics failed: " +
    (error instanceof Error ? error.message : "Unknown error") + "\n",
  );
  process.exitCode = 1;
});
