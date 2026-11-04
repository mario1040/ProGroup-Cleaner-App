import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./connection";

async function main(): Promise<void> {
  const connectionString = assertNarisDatabaseUrl(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString });
  try {
    const schema = readFileSync("server/db/schema.sql", "utf8");
    await pool.query(schema);
    const result = await pool.query<{ missing: string[] }>(
      "SELECT ARRAY_REMOVE(ARRAY[" +
        "CASE WHEN to_regclass('public.users') IS NULL THEN 'users' END, " +
        "CASE WHEN to_regclass('public.auth_sessions') IS NULL THEN 'auth_sessions' END, " +
        "CASE WHEN to_regclass('public.locations') IS NULL THEN 'locations' END, " +
        "CASE WHEN to_regclass('public.zones') IS NULL THEN 'zones' END, " +
        "CASE WHEN to_regclass('public.sop_items') IS NULL THEN 'sop_items' END, " +
        "CASE WHEN to_regclass('public.task_templates') IS NULL THEN 'task_templates' END, " +
        "CASE WHEN to_regclass('public.task_instances') IS NULL THEN 'task_instances' END, " +
        "CASE WHEN to_regclass('public.task_media') IS NULL THEN 'task_media' END, " +
        "CASE WHEN to_regclass('public.operational_tasks') IS NULL THEN 'operational_tasks' END, " +
        "CASE WHEN to_regclass('public.device_switches') IS NULL THEN 'device_switches' END, " +
        "CASE WHEN to_regclass('public.kpi_snapshots') IS NULL THEN 'kpi_snapshots' END, " +
        "CASE WHEN to_regclass('public.audit_logs') IS NULL THEN 'audit_logs' END" +
      "], NULL) AS missing",
    );
    const missing = result.rows[0]?.missing || [];
    if (missing.length) throw new Error("Schema smoke test missing tables: " + missing.join(", "));
    const phone = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'",
    );
    if (phone.rowCount !== 1) throw new Error("users.phone column is missing");
    const indexes = await pool.query(
      "SELECT to_regclass('public.users_username_ci_uq') AS username_index, " +
      "to_regclass('public.task_instances_recurring_occurrence_uq') AS recurrence_index",
    );
    if (!indexes.rows[0]?.username_index || !indexes.rows[0]?.recurrence_index) {
      throw new Error("Required uniqueness indexes are missing");
    }
    process.stdout.write("PostgreSQL schema smoke test passed.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack || error.message : error) + "\n");
  process.exitCode = 1;
});
