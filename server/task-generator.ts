import type { Pool, PoolClient } from "pg";
import {
  generateDailyTaskPlan,
  type CleanerProfile,
  type ExistingTask,
  type RecurringSop,
  type TaskZone,
} from "./task-engine";

interface SopRow extends Record<string, unknown> {
  id: string;
  title: string;
  zone_id: string;
  task_code: string | null;
  frequency: string;
  recurrence_days: unknown;
  scheduled_time: string | null;
  scheduled_times: unknown;
  default_assignee_id: string | null;
  is_active: boolean;
  created_at: Date | string | null;
  raw_data: Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mapSop(row: SopRow): RecurringSop {
  const data = row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
    ? row.raw_data
    : {};
  const createdAt = row.created_at ?? data.created_at;

  // Normalized PostgreSQL columns are authoritative. raw_data is retained only
  // for descriptive/optional fields and legacy compatibility.
  return {
    ...(data as unknown as RecurringSop),
    id: String(row.id),
    title: String(row.title || data.title || ""),
    zone_id: String(row.zone_id || data.zone_id || ""),
    task_code: row.task_code ?? (typeof data.task_code === "string" ? data.task_code : undefined),
    frequency: String(row.frequency || data.frequency || ""),
    recurrence_days: Array.isArray(row.recurrence_days)
      ? stringArray(row.recurrence_days)
      : stringArray(data.recurrence_days),
    scheduled_time: row.scheduled_time ?? (typeof data.scheduled_time === "string" ? data.scheduled_time : null),
    scheduled_times: Array.isArray(row.scheduled_times)
      ? stringArray(row.scheduled_times)
      : stringArray(data.scheduled_times),
    default_assignee_id: row.default_assignee_id,
    is_active: row.is_active === true,
    created_at: createdAt instanceof Date ? createdAt.toISOString() : typeof createdAt === "string" ? createdAt : undefined,
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
    due_date: row.due_date instanceof Date
      ? row.due_date.toISOString().slice(0, 10)
      : String(row.due_date).slice(0, 10),
    task_type: String(row.task_type),
  };
}

export interface TaskGenerationSummary {
  date: string;
  generated: number;
  skippedAlreadyExists: number;
  skippedNoEligibleCleaner: number;
  runId: string;
  dryRun: boolean;
  assignmentBreakdown: Array<{ cleanerId: string; cleanerName: string; count: number }>;
}

export async function generateRecurringTasksForDate(
  pool: Pool,
  date: string,
  now = new Date(),
  dryRun = false,
): Promise<TaskGenerationSummary> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");
    // Serialize same-day generation across all app instances.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "naris-task-generator:" + date,
    ]);

    const runId = dryRun
      ? "dry-run"
      : (await client.query<{ id: string }>(
          "INSERT INTO task_generation_runs (run_date, status) " +
            "VALUES ($1::date, 'running') RETURNING id::text AS id",
          [date],
        )).rows[0].id;

    const sopRows = await client.query<SopRow>(
      "SELECT id, title, zone_id, task_code, frequency, recurrence_days, " +
        "scheduled_time, scheduled_times, default_assignee_id, is_active, created_at, raw_data " +
        "FROM sop_items WHERE is_active = TRUE ORDER BY id",
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
    const cleanerNames = new Map(profileRows.rows.map((row) => [
      String(row.id),
      String(row.full_name || row.username || row.id),
    ]));
    const assignmentCounts = new Map<string, number>();
    for (const task of plan.generated) {
      assignmentCounts.set(task.assigned_to, (assignmentCounts.get(task.assigned_to) || 0) + 1);
    }
    const assignmentBreakdown = [...assignmentCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cleanerId, count]) => ({
        cleanerId,
        cleanerName: cleanerNames.get(cleanerId) || cleanerId,
        count,
      }));

    if (dryRun) {
      await client.query("ROLLBACK");
      return {
        date,
        generated: plan.generated.length,
        skippedAlreadyExists: plan.skippedAlreadyExists,
        skippedNoEligibleCleaner: plan.skippedNoEligibleCleaner,
        runId,
        dryRun: true,
        assignmentBreakdown,
      };
    }

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
      dryRun: false,
      assignmentBreakdown,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Persist failed attempts outside the rolled-back transaction.
    if (!dryRun) await pool.query(
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
