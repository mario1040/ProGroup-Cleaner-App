import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { app, pool } from "./http";
import { generateRecurringTasksForDate } from "./task-generator";

const suffix = randomBytes(5).toString("hex");
const adminId = "it_admin_" + suffix;
const supervisorId = "it_supervisor_" + suffix;
const cleanerId = "it_cleaner_" + suffix;
const locationId = "it_location_" + suffix;
const zoneId = "it_zone_" + suffix;
const taskId = "it_task_" + suffix;
const rejectTaskId = "it_reject_" + suffix;
const createdUserIds: string[] = [];
const createdTaskIds: string[] = [taskId, rejectTaskId];
const createdSopIds: string[] = [];
const createdTemplateIds: string[] = [];
const createdInventoryIds: string[] = [];
let server: ReturnType<typeof app.listen>;
let baseUrl = "";

function passwordRecord(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + ":" + password).digest("hex");
  return salt + ":" + hash;
}

function cairoDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

async function seedUser(id: string, username: string, role: string, password: string): Promise<void> {
  const raw = {
    id, username, full_name: username, role, phone: null,
    is_active: true, created_at: new Date().toISOString(),
  };
  await pool.query(
    "INSERT INTO users (id, username, full_name, phone, role, is_active, password_record, raw_data) " +
    "VALUES ($1,$2,$3,NULL,$4,TRUE,$5,$6::jsonb)",
    [id, username, username, role, passwordRecord(password), JSON.stringify(raw)],
  );
}

async function api(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
): Promise<{ response: Response; payload: any }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function login(username: string, password: string): Promise<string> {
  const { response, payload } = await api("/api/auth/login", "POST", { identifier: username, password });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return String(setCookie).split(";")[0];
}

describe("PostgreSQL HTTP integration", () => {
  it("serves JSON health probes to trusted AI Studio previews without widening API CORS", async () => {
    const previewOrigin = "https://ais-dev-test-123.europe-west2.run.app";
    const liveResponse = await fetch(baseUrl + "/health/live", {
      headers: { Origin: previewOrigin },
    });
    const livePayload = await liveResponse.json();
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get("access-control-allow-origin")).toBe(previewOrigin);
    expect(livePayload).toMatchObject({ ok: true, status: "ok", service: "naris-api" });

    const dbResponse = await fetch(baseUrl + "/health/db", {
      headers: { Origin: previewOrigin },
    });
    const dbPayload = await dbResponse.json();
    expect(dbResponse.status).toBe(200);
    expect(dbPayload).toMatchObject({ ok: true, database: "connected", query: true });

    const readyResponse = await fetch(baseUrl + "/health/ready", {
      headers: { Origin: previewOrigin },
    });
    const readyPayload = await readyResponse.json();
    expect(readyResponse.status).toBe(200);
    expect(readyPayload).toMatchObject({
      ok: true,
      status: "ready",
      database: "connected",
      checks: { connection: true, query: true, requiredTables: true },
      missingTables: [],
    });

    const preflight = await fetch(baseUrl + "/health/ready", {
      method: "OPTIONS",
      headers: {
        Origin: previewOrigin,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(previewOrigin);

    const protectedApi = await fetch(baseUrl + "/api/users", {
      headers: { Origin: previewOrigin },
    });
    expect(protectedApi.status).toBe(403);
  });

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO locations (id, name, raw_data) VALUES ($1, 'Integration test location', $2::jsonb)",
      [locationId, JSON.stringify({ id: locationId, name: "Integration test location" })],
    );
    await pool.query(
      "INSERT INTO zones (id, location_id, name, raw_data) VALUES ($1,$2,'Integration test zone',$3::jsonb)",
      [zoneId, locationId, JSON.stringify({ id: zoneId, location_id: locationId, name: "Integration test zone" })],
    );
    await seedUser(adminId, "it_admin_" + suffix, "admin", "AdminTest!123");
    await seedUser(supervisorId, "it_supervisor_" + suffix, "supervisor", "SupervisorTest!123");
    await seedUser(cleanerId, "it_cleaner_" + suffix, "cleaner", "CleanerTest!123");

    const now = new Date().toISOString();
    const dueDate = cairoDate();
    const seedTask = (id: string) => ({
      id, template_id: null, sop_item_id: null, zone_id: zoneId,
      assigned_to: cleanerId, assigned_by: adminId, task_type: "one_time",
      title: "Integration task", description: "Test task", due_date: dueDate,
      due_time: "10:00", status: "pending", requires_photo_before: true,
      requires_photo_after: true, requires_supervisor_approval: true,
      supervisor_approved: false, created_at: now, updated_at: now,
    });
    for (const id of [taskId, rejectTaskId]) {
      const raw = seedTask(id);
      await pool.query(
        "INSERT INTO task_instances (id, zone_id, assigned_to, assigned_by, task_type, title, description, " +
        "due_date, due_time, status, raw_data, created_at, updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11::jsonb,$12::timestamptz,$13::timestamptz)",
        [id, zoneId, cleanerId, adminId, "one_time", raw.title, raw.description,
          dueDate, "10:00", "pending", JSON.stringify(raw), now, now],
      );
    }
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind a TCP port");
    baseUrl = "http://127.0.0.1:" + address.port;
  }, 20000);

  afterAll(async () => {
    const userIds = [adminId, supervisorId, cleanerId, ...createdUserIds];
    await pool.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::text[])", [userIds]);
    await pool.query(
      "DELETE FROM audit_logs WHERE task_id = ANY($1::text[]) OR metadata->>'actor_id' = ANY($2::text[]) OR metadata->>'user_id' = ANY($2::text[])",
      [createdTaskIds, userIds],
    );
    await pool.query("DELETE FROM inventory_items WHERE id = ANY($1::text[])", [createdInventoryIds]);
    await pool.query("DELETE FROM task_media WHERE task_id = ANY($1::text[])", [createdTaskIds]);
    await pool.query("DELETE FROM task_instances WHERE id = ANY($1::text[])", [createdTaskIds]);
    await pool.query("DELETE FROM task_generation_runs WHERE run_date = $1::date", ["2099-05-03"]);
    await pool.query("DELETE FROM task_templates WHERE id = ANY($1::text[])", [createdTemplateIds]);
    await pool.query("DELETE FROM sop_items WHERE id = ANY($1::text[])", [createdSopIds]);
    await pool.query("DELETE FROM zones WHERE id = $1", [zoneId]);
    await pool.query("DELETE FROM locations WHERE id = $1", [locationId]);
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]);
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => error ? reject(error) : resolve()),
    );
    await pool.end();
  }, 20000);

  it("authenticates users, enforces roles, executes task lifecycle, and calculates KPI", async () => {
    const adminCookie = await login("it_admin_" + suffix, "AdminTest!123");
    const supervisorCookie = await login("it_supervisor_" + suffix, "SupervisorTest!123");
    const cleanerCookie = await login("it_cleaner_" + suffix, "CleanerTest!123");

    const me = await api("/api/auth/me", "GET", undefined, cleanerCookie);
    expect(me.response.status).toBe(200);
    expect(me.payload.user.id).toBe(cleanerId);

    const deniedUsers = await api("/api/users", "GET", undefined, cleanerCookie);
    expect(deniedUsers.response.status).toBe(403);

    const cleanerTasks = await api("/api/tasks?date=" + cairoDate(), "GET", undefined, cleanerCookie);
    expect(cleanerTasks.response.status).toBe(200);
    expect(cleanerTasks.payload.data.some((task: any) => task.id === taskId)).toBe(true);

    const missingTaskSignature = await api("/api/media/upload-signature", "POST", {
      task_id: "missing_task_" + suffix,
      side: "before",
    }, cleanerCookie);
    expect(missingTaskSignature.response.status).toBe(404);

    const ownTaskSignature = await api("/api/media/upload-signature", "POST", {
      task_id: taskId,
      side: "before",
    }, cleanerCookie);
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
      expect(ownTaskSignature.response.status).toBe(200);
      expect(ownTaskSignature.payload).toMatchObject({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        folder: "task-photos/" + zoneId + "/" + taskId,
        tags: "naris-ops,production",
        side: "before",
      });
      expect(ownTaskSignature.payload.signature).toMatch(/^[a-f0-9]{40}$/);
    } else {
      expect(ownTaskSignature.response.status).toBe(503);
    }

    const startBlocked = await api("/api/tasks/" + taskId, "PATCH", { status: "in_progress" }, cleanerCookie);
    expect(startBlocked.response.status).toBe(422);

    const started = await api("/api/tasks/" + taskId, "PATCH", {
      status: "in_progress",
      photo_before_url: "https://res.cloudinary.com/demo/before.jpg",
      photo_before_public_id: "task-photos/" + zoneId + "/" + taskId + "/before",
      photo_before_mime_type: "image/jpeg", photo_before_size: 1024,
    }, cleanerCookie);
    expect(started.response.status).toBe(200);
    expect(started.payload.data.started_at).toBeTruthy();

    const completionBlocked = await api("/api/tasks/" + taskId, "PATCH", {
      status: "completed",
    }, cleanerCookie);
    expect(completionBlocked.response.status).toBe(422);

    const completed = await api("/api/tasks/" + taskId, "PATCH", {
      status: "completed",
      photo_after_url: "https://res.cloudinary.com/demo/after.jpg",
      photo_after_public_id: "task-photos/" + zoneId + "/" + taskId + "/after",
      photo_after_mime_type: "image/jpeg", photo_after_size: 2048,
    }, cleanerCookie);
    expect(completed.response.status).toBe(200);
    expect(completed.payload.data.completed_at).toBeTruthy();
    const lockedCompletedTask = await api("/api/tasks/" + taskId, "PATCH", {
      employee_notes: "Attempt to alter submitted evidence",
    }, cleanerCookie);
    expect(lockedCompletedTask.response.status).toBe(409);
    const mediaRows = await pool.query(
      "SELECT side, storage_provider, public_id, secure_url, byte_size FROM task_media WHERE task_id = $1 ORDER BY side",
      [taskId],
    );
    expect(mediaRows.rows).toHaveLength(2);
    expect(mediaRows.rows.map((row) => row.side)).toEqual(["after", "before"]);
    expect(mediaRows.rows.every((row) => row.storage_provider === "cloudinary")).toBe(true);
    expect(mediaRows.rows.find((row) => row.side === "before")?.byte_size).toBe("1024");

    const approved = await api("/api/tasks/" + taskId + "/approve", "POST", {
      quality_grade: "B", supervisor_notes: "Integration approval",
    }, supervisorCookie);
    expect(approved.response.status).toBe(200);
    expect(approved.payload.data.supervisor_approved).toBe(true);
    const duplicateApproval = await api("/api/tasks/" + taskId + "/approve", "POST", {
      quality_grade: "A", supervisor_notes: "Duplicate approval must be blocked",
    }, supervisorCookie);
    expect(duplicateApproval.response.status).toBe(409);

    const kpis = await api("/api/kpis", "GET", undefined, adminCookie);
    expect(kpis.response.status).toBe(200);
    const cleanerKpi = kpis.payload.data.find((item: any) => item.profile_id === cleanerId);
    expect(cleanerKpi.tasks_assigned).toBe(2);
    expect(cleanerKpi.quality_score).toBe(80);

    const prematureReject = await api("/api/tasks/" + rejectTaskId + "/reject", "POST", {
      supervisor_notes: "Pending task must not enter review",
    }, supervisorCookie);
    expect(prematureReject.response.status).toBe(409);

    const reworkStarted = await api("/api/tasks/" + rejectTaskId, "PATCH", {
      status: "in_progress",
      photo_before_url: "https://res.cloudinary.com/demo/rework-before.jpg",
      photo_before_public_id: "task-photos/" + zoneId + "/" + rejectTaskId + "/before",
      photo_before_mime_type: "image/jpeg", photo_before_size: 1024,
    }, cleanerCookie);
    expect(reworkStarted.response.status).toBe(200);
    const reworkCompleted = await api("/api/tasks/" + rejectTaskId, "PATCH", {
      status: "completed",
      photo_after_url: "https://res.cloudinary.com/demo/rework-after.jpg",
      photo_after_public_id: "task-photos/" + zoneId + "/" + rejectTaskId + "/after",
      photo_after_mime_type: "image/jpeg", photo_after_size: 1024,
    }, cleanerCookie);
    expect(reworkCompleted.response.status).toBe(200);

    const rejected = await api("/api/tasks/" + rejectTaskId + "/reject", "POST", {
      supervisor_notes: "Integration rejection",
    }, supervisorCookie);
    expect(rejected.response.status).toBe(200);
    expect(rejected.payload.data.original.status).toBe("rejected");
    expect(rejected.payload.data.rework.task_type).toBe("rework");
    expect(rejected.payload.data.rework.parent_instance_id).toBe(rejectTaskId);
    createdTaskIds.push(rejected.payload.data.rework.id);

    const created = await api("/api/tasks", "POST", {
      title: "Integration created task", zone_id: zoneId,
      due_time: "11:00",
    }, supervisorCookie);
    expect(created.response.status).toBe(201);
    createdTaskIds.push(created.payload.data.id);

    const sop = await api("/api/sop-items", "POST", {
      title: "Integration SOP", zone_id: zoneId, frequency: "يومي",
      recurrence_days: [], scheduled_times: ["09:00"], is_active: true,
      requires_photo_before: true, requires_photo_after: true,
      requires_supervisor_approval: true, is_reopenable: false,
      auto_escalate_if_late: false,
    }, supervisorCookie);
    expect(sop.response.status).toBe(201);
    createdSopIds.push(sop.payload.data.id);

    const template = await api("/api/task-templates", "POST", {
      title: "Integration task template", task_code: "IT_TEMPLATE_" + suffix,
      zone_id: zoneId, frequency: "يومي", category: "نظافة",
      requires_photo_before: true, requires_photo_after: true,
      is_active: true, recurrence_days: [], scheduled_times: ["09:00"],
    }, supervisorCookie);
    expect(template.response.status).toBe(201);
    createdTemplateIds.push(template.payload.data.id);
    const templates = await api("/api/task-templates", "GET", undefined, supervisorCookie);
    expect(templates.response.status).toBe(200);
    expect(templates.payload.data.some((item: any) => item.id === template.payload.data.id)).toBe(true);
    const templateUpdated = await api("/api/task-templates/" + template.payload.data.id, "PATCH", {
      description: "Persisted template update",
    }, supervisorCookie);
    expect(templateUpdated.response.status).toBe(200);
    expect(templateUpdated.payload.data.description).toBe("Persisted template update");
    const templateDeleted = await api("/api/task-templates/" + template.payload.data.id, "DELETE", undefined, supervisorCookie);
    expect(templateDeleted.response.status).toBe(200);
    createdTemplateIds.pop();

    // Simulate a Firestore-imported SOP whose source JSON omitted normalized fields.
    // The generator and admin API must rely on the canonical PostgreSQL columns.
    await pool.query(
      "UPDATE sop_items SET raw_data = raw_data - ARRAY[" +
        "'id','title','zone_id','task_code','frequency','recurrence_days'," +
        "'scheduled_time','scheduled_times','default_assignee_id','is_active'" +
      "]::text[] WHERE id = $1",
      [sop.payload.data.id],
    );
    const listedSops = await api("/api/sop-items", "GET", undefined, supervisorCookie);
    expect(listedSops.response.status).toBe(200);
    const listedSop = listedSops.payload.data.find((item: any) => item.id === sop.payload.data.id);
    expect(listedSop.title).toBe("Integration SOP");
    expect(listedSop.zone_id).toBe(zoneId);
    expect(listedSop.frequency).toBe("يومي");

    const dryRun = await generateRecurringTasksForDate(pool, "2099-05-04", new Date(), true);
    expect(dryRun).toMatchObject({ date: "2099-05-04", generated: 1, dryRun: true });
    const dryRunTasks = await pool.query(
      "SELECT COUNT(*)::int AS count FROM task_instances WHERE due_date = '2099-05-04'::date",
    );
    const dryRunRuns = await pool.query(
      "SELECT COUNT(*)::int AS count FROM task_generation_runs WHERE run_date = '2099-05-04'::date",
    );
    expect(dryRunTasks.rows[0].count).toBe(0);
    expect(dryRunRuns.rows[0].count).toBe(0);

    const generated = await generateRecurringTasksForDate(pool, "2099-05-03");
    expect(generated.generated).toBe(1);
    const repeated = await generateRecurringTasksForDate(pool, "2099-05-03");
    expect(repeated.generated).toBe(0);
    expect(repeated.skippedAlreadyExists).toBe(1);
    const generatedTaskId = "ti_rec_" + sop.payload.data.id + "_2099-05-03_0";
    createdTaskIds.push(generatedTaskId);
    const generatedRow = await pool.query(
      "SELECT id, assigned_to, due_date, task_type, title, sop_item_id FROM task_instances WHERE id = $1",
      [generatedTaskId],
    );
    expect(generatedRow.rowCount).toBe(1);
    expect(generatedRow.rows[0].assigned_to).toBe(cleanerId);
    expect(generatedRow.rows[0].task_type).toBe("recurring");
    expect(generatedRow.rows[0].title).toBe("Integration SOP");
    expect(generatedRow.rows[0].sop_item_id).toBe(sop.payload.data.id);

    const sopUpdated = await api("/api/sop-items/" + sop.payload.data.id, "PATCH", {
      title: "Integration SOP updated",
    }, supervisorCookie);
    expect(sopUpdated.response.status).toBe(200);

    const createdUser = await api("/api/users", "POST", {
      username: "it_new_" + suffix, full_name: "Integration new cleaner",
      role: "cleaner", phone: "01000000000",
    }, adminCookie);
    expect(createdUser.response.status).toBe(201);
    expect(createdUser.payload.generatedPassword).toBeTruthy();
    createdUserIds.push(createdUser.payload.profile.id);

    const inventoryCreated = await api("/api/inventory-items", "POST", {
      name: "Integration inventory item",
      category: "معدات تنظيف",
      quantity: 8,
      min_quantity: 3,
    }, adminCookie);
    expect(inventoryCreated.response.status).toBe(201);
    expect(inventoryCreated.payload.data.status).toBe("متوفر");
    createdInventoryIds.push(inventoryCreated.payload.data.id);

    const inventoryListed = await api("/api/inventory-items", "GET", undefined, adminCookie);
    expect(inventoryListed.response.status).toBe(200);
    expect(inventoryListed.payload.data.some((item: any) => item.id === inventoryCreated.payload.data.id)).toBe(true);

    const inventoryUpdated = await api("/api/inventory-items/" + inventoryCreated.payload.data.id, "PATCH", {
      quantity: 2,
    }, adminCookie);
    expect(inventoryUpdated.response.status).toBe(200);
    expect(inventoryUpdated.payload.data.status).toBe("منخفض");

    const inventoryDeleted = await api("/api/inventory-items/" + inventoryCreated.payload.data.id, "DELETE", undefined, adminCookie);
    expect(inventoryDeleted.response.status).toBe(200);

    const validation = await api("/api/system/validation", "GET", undefined, adminCookie);
    expect(validation.response.status).toBe(200);
    expect(validation.payload.isPassed).toBe(true);
  }, 30000);
});
