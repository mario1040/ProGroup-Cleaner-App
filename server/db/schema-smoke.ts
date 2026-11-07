import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./connection";

const REQUIRED_TABLES = [
  "users",
  "auth_sessions",
  "locations",
  "zones",
  "sop_items",
  "task_templates",
  "task_instances",
  "task_generation_runs",
  "task_media",
  "operational_tasks",
  "device_switches",
  "inventory_items",
  "kpi_snapshots",
  "audit_logs",
  "firestore_documents",
] as const;

async function main(): Promise<void> {
  const connectionString = assertNarisDatabaseUrl(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables " +
        "WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
      [REQUIRED_TABLES],
    );
    const found = new Set(result.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((table) => !found.has(table));
    if (missing.length) {
      throw new Error("Schema smoke test missing tables: " + missing.join(", "));
    }

    const phone = await pool.query(
      "SELECT 1 FROM information_schema.columns " +
        "WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'phone'",
    );
    if (phone.rowCount !== 1) throw new Error("users.phone column is missing");

    const indexes = await pool.query(
      "SELECT to_regclass('public.users_username_ci_uq') AS username_index, " +
        "to_regclass('public.task_instances_recurring_occurrence_uq') AS recurrence_index",
    );
    if (!indexes.rows[0]?.username_index || !indexes.rows[0]?.recurrence_index) {
      throw new Error("Required uniqueness indexes are missing");
    }

    const privileges = await pool.query<{
      can_create_schema: boolean;
      can_create_database: boolean;
      can_select_users: boolean;
      can_insert_users: boolean;
      can_update_users: boolean;
      can_delete_users: boolean;
      can_truncate_users: boolean;
      can_use_generation_sequence: boolean;
      owned_public_objects: string;
      privileged_memberships: string;
      is_superuser: boolean;
      can_create_roles: boolean;
      can_replicate: boolean;
      can_bypass_rls: boolean;
    }>(
      "SELECT " +
        "has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema, " +
        "has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database, " +
        "has_table_privilege(current_user, 'public.users', 'SELECT') AS can_select_users, " +
        "has_table_privilege(current_user, 'public.users', 'INSERT') AS can_insert_users, " +
        "has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_update_users, " +
        "has_table_privilege(current_user, 'public.users', 'DELETE') AS can_delete_users, " +
        "has_table_privilege(current_user, 'public.users', 'TRUNCATE') AS can_truncate_users, " +
        "has_sequence_privilege(current_user, 'public.task_generation_runs_id_seq', 'USAGE') AS can_use_generation_sequence, " +
        "r.rolsuper AS is_superuser, r.rolcreaterole AS can_create_roles, " +
        "r.rolreplication AS can_replicate, r.rolbypassrls AS can_bypass_rls, " +
        "(SELECT COUNT(*)::text FROM pg_auth_members m JOIN pg_roles member ON member.oid = m.member " +
        " WHERE member.rolname = current_user) AS privileged_memberships, " +
        "(SELECT COUNT(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        " WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') " +
        " AND pg_get_userbyid(c.relowner) = current_user) AS owned_public_objects " +
        "FROM pg_roles r WHERE r.rolname = current_user",
    );
    const p = privileges.rows[0];
    if (
      p.can_create_schema ||
      p.can_create_database ||
      p.can_truncate_users ||
      p.is_superuser ||
      p.can_create_roles ||
      p.can_replicate ||
      p.can_bypass_rls ||
      Number(p.privileged_memberships) > 0 ||
      !p.can_select_users ||
      !p.can_insert_users ||
      !p.can_update_users ||
      !p.can_delete_users ||
      !p.can_use_generation_sequence ||
      Number(p.owned_public_objects) > 0
    ) {
      throw new Error("Runtime database role is not least-privilege: " + JSON.stringify(p));
    }

    process.stdout.write(
      "PostgreSQL schema and least-privilege runtime-role smoke tests passed.\n",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.stack || error.message : error) + "\n");
  process.exitCode = 1;
});
