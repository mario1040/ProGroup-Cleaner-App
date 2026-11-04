import type { Pool, PoolClient } from "pg";
import {
  generateDailyTaskPlan,
  type CleanerProfile,
  type ExistingTask,
  type RecurringSop,
  type TaskZone,
} from "./task-engine";

interface RawJsonRow extends Record<string, unknown> {
  raw_data: Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapSop(row: RawJsonRow): RecurringSop {
  const data = row.raw_data;
  return {
    ...(data as unknown as RecurringSop),
    recurrence_days: stringArray(data.recurrence_days),
    scheduled_times: stringArray(data.scheduled_times),
  };
}

function mapProfile(row: Record<string, unknown>): CleanerProfile {
  return {
    id: String(row.id),
    role: String(row.role),
    is_active: row.is_active === true,
  };
}

function mapZone(row: Record<string, unknown>): TaskZone {
  return {
    id: String(row.id),
    responsible_employee_id:
      typeof row.responsible_employee_id === "string"
        ? row.responsible_employee_id
        : null,
  };
}

function mapTask(row: Record<string, unknown>): ExistingTask {
  return {
    id: String(row.id),
    assigned_to: String(row.assigned_to),
    due_date: String(row.due_date).slice(0, 10),
    task_type: String(row.task_type),
  };
}

export interface TaskGenerationSummary {
  date: string;
  generated: number;
  skippedAlreadyExists: number;
  skippedNoEligibleCleaner: number;
  runId: string;
}

export async function generateRecurringTasksForDate(
  pool: Pool,
  date: string,
  now = new Date(),
): Promise<TaskGenerationSummary> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");
    // Serialize same-day generation across all app instances.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "naris-task-generator:" + date,
    ]);

    const run = await client.query<{ id: string }>(
      "INSERT INTO task_generation_runs (run_date, status) " +
        "VALUES ($1::date, 'running') RETURNING id::text AS id",
      [date],
    );
    const runId = run.rows[0].id;

    const sopRows = await client.query<RawJsonRow>(
      "SELECT raw_data FROM sop_items WHERE is_active = TRUE ORDER BY id",
    );
    const profileRows = await client.query<Record<string, unknown>>(
      "SELECT id, role, is_active FROM users " +
        "WHERE role = 'cleaner' AND is_active = TRUE ORDER BY id",
    );
    const zoneRows = await client.query<Record<string, unknown>>(
      "SELECT id, responsible_employee_id FROM zones",
    );
    const taskRows = await client.query<Record<string, unknown>>(
      "SELECT id, assigned_to, due_date, task_type " +
        "FROM task_instances WHERE due_date = $1::date",
      [date],
    );

    const plan = generateDailyTaskPlan({
      date,
      sops: sopRows.rows.map(mapSop),
      profiles: profileRows.rows.map(mapProfile),
      zones: zoneRows.rows.map(mapZone),
      existingTasks: taskRows.rows.map(mapTask),
      now,
    });

    let inserted = 0;
    const insertSql =
      "INSERT INTO task_instances (" +
      "id, template_id, sop_item_id, zone_id, assigned_to, assigned_by, " +
      "task_type, title, description, due_date, due_time, status, " +
      "occurrence_index, raw_data, created_at, updated_at" +
      ") VALUES (" +
      "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, " +
      "$13, $14::jsonb, $15::timestamptz, $16::timestamptz" +
      ") ON CONFLICT DO NOTHING";

    for (const task of plan.generated) {
      const result = await client.query(insertSql, [
        task.id,
        task.template_id,
        task.sop_item_id,
        task.zone_id,
        task.assigned_to,
        task.assigned_by,
        task.task_type,
        task.title,
        task.description,
        task.due_date,
        task.due_time,
        task.status,
        task.occurrence_index,
        JSON.stringify(task),
        task.created_at,
        task.updated_at,
      ]);
      inserted += result.rowCount ?? 0;
    }

    await client.query(
      "UPDATE task_generation_runs SET status = 'completed', " +
        "completed_at = NOW(), generated_count = $2, " +
        "skipped_existing_count = $3, skipped_no_assignee_count = $4 " +
        "WHERE id = $1::bigint",
      [runId, inserted, plan.skippedAlreadyExists, plan.skippedNoEligibleCleaner],
    );

    await client.query("COMMIT");

    return {
      date,
      generated: inserted,
      skippedAlreadyExists: plan.skippedAlreadyExists,
      skippedNoEligibleCleaner: plan.skippedNoEligibleCleaner,
      runId,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Persist failed attempts outside the rolled-back transaction.
    await pool.query(
      "INSERT INTO task_generation_runs " +
        "(run_date, completed_at, status, error_message) " +
        "VALUES ($1::date, NOW(), 'failed', $2)",
      [
        date,
        error instanceof Error ? error.message.slice(0, 1000) : "Unknown error",
      ],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
