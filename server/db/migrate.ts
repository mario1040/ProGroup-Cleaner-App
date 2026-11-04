import "dotenv/config";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./connection";

async function main(): Promise<void> {
  const connectionString = assertNarisDatabaseUrl(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  });
  try {
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    await pool.query(schema);
    const required = [
      "users", "auth_sessions", "locations", "zones", "sop_items", "task_templates",
      "task_instances", "operational_tasks", "device_switches",
      "kpi_snapshots", "audit_logs", "task_generation_runs",
      "firestore_documents",
    ];
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [required],
    );
    const found = new Set(result.rows.map((row) => row.table_name));
    const missing = required.filter((table) => !found.has(table));
    if (missing.length) throw new Error("Schema migration incomplete: " + missing.join(", "));
    process.stdout.write("Naris Ops PostgreSQL schema applied and verified.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write("Naris schema migration failed: " +
    (error instanceof Error ? error.message : "unknown error") + "\n");
  process.exitCode = 1;
});
