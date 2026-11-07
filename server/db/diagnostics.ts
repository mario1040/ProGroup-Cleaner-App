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
      todayTasks, todayRuns, integrity, sourceCollections, media] = await Promise.all([
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
