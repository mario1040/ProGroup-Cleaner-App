import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./db/connection";
import { applyTaskUpdate, type TaskRecord } from "./task-rules";

type Role = "admin" | "supervisor" | "cleaner";
interface AuthContext { id: string; username: string; full_name: string; role: Role; is_active: boolean; }
type AuthRequest = Request & { auth?: AuthContext };

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});
const PORT = Number(process.env.API_PORT || 4000);
const SESSION_HOURS = 12;
const COOKIE_NAME = "naris_session";
const allowedOrigins = new Set(
  (process.env.APP_ALLOWED_ORIGINS || "http://localhost:3000,http://localhost:5173")
    .split(",").map((origin) => origin.trim()).filter(Boolean),
);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return null;
}
function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production";
  // Lax is the safe default for a same-site deployment. Cross-site deployments
  // must explicitly opt into SameSite=None and HTTPS.
  const configuredSameSite = (process.env.SESSION_COOKIE_SAMESITE || "Lax").toLowerCase();
  const sameSite = configuredSameSite === "none" ? "None"
    : configuredSameSite === "strict" ? "Strict" : "Lax";
  if (sameSite === "None" && !secure) {
    throw new Error("SameSite=None requires NODE_ENV=production and HTTPS.");
  }
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; HttpOnly; Path=/; SameSite=" + sameSite +
    (secure ? "; Secure" : "") + "; Max-Age=" + String(SESSION_HOURS * 3600));
}
function clearSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === "production";
  const configuredSameSite = (process.env.SESSION_COOKIE_SAMESITE || "Lax").toLowerCase();
  const sameSite = configuredSameSite === "none" ? "None"
    : configuredSameSite === "strict" ? "Strict" : "Lax";
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=; HttpOnly; Path=/; SameSite=" + sameSite +
    (secure ? "; Secure" : "") + "; Max-Age=0");
}
function publicProfile(row: Record<string, unknown>): AuthContext & Record<string, unknown> {
  const raw = row.raw_data && typeof row.raw_data === "object" && !Array.isArray(row.raw_data)
    ? { ...(row.raw_data as Record<string, unknown>) }
    : {};
  delete raw.password;
  delete raw.password_record;
  return {
    ...raw,
    id: String(row.id),
    username: String(row.username),
    full_name: String(row.full_name),
    role: row.role as Role,
    is_active: row.is_active === true,
  };
}
function verifyPassword(plain: string, record: string): boolean {
  const parts = record.split(":");
  if (parts.length === 2 && /^[a-f0-9]{16,}$/i.test(parts[0]) && /^[a-f0-9]{64}$/i.test(parts[1])) {
    return safeEqual(sha256(parts[0] + ":" + plain), parts[1]);
  }
  // Legacy plaintext records are accepted only to permit a successful login and immediate upgrade.
  return record.length > 0 && record === plain;
}
function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + sha256(salt + ":" + plain);
}
function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) { res.status(401).json({ error: "Authentication required" }); return; }
  void pool.query(
    "SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.raw_data " +
    "FROM auth_sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE",
    [sha256(token)],
  ).then((result) => {
    if (result.rowCount !== 1) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Session expired" });
      return;
    }
    req.auth = publicProfile(result.rows[0]);
    next();
  }).catch(next);
}
function allowRoles(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  const isStateChanging = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  // Browser state-changing requests always carry Origin. In production, reject
  // origin-less writes so an attacker cannot bypass the allowlist via CSRF.
  if (isStateChanging && process.env.NODE_ENV === "production" && !origin) {
    res.status(403).json({ error: "Origin header required" });
    return;
  }
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
}
function getBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "Africa/Cairo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function asyncRoute(
  handler: (req: AuthRequest, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req as AuthRequest, res).catch(next);
  };
}

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  }
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
app.use(express.json({ limit: "2mb", strict: true }));
app.use(requireSameOrigin);

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const ip = req.ip || "unknown";
  // Bound memory use if this process is exposed to many distinct source IPs.
  if (loginAttempts.size > 10_000) {
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= Date.now()) loginAttempts.delete(key);
    }
    if (loginAttempts.size > 10_000) loginAttempts.clear();
  }
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    res.status(429).json({ error: "Too many login attempts. Try again later." });
    return;
  }
  const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!identifier || !password || password.length > 256) {
    res.status(400).json({ error: "Identifier and password are required" });
    return;
  }

  const result = await pool.query(
    "SELECT id, username, full_name, phone, role, is_active, password_record, raw_data " +
    "FROM users WHERE LOWER(username) = LOWER($1) OR phone = $1 OR LOWER(full_name) = LOWER($1) " +
    "ORDER BY CASE WHEN LOWER(username) = LOWER($1) THEN 0 WHEN phone = $1 THEN 1 ELSE 2 END LIMIT 1",
    [identifier],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const record = typeof row?.password_record === "string" ? row.password_record : "";
  if (!row || row.is_active !== true || !verifyPassword(password, record)) {
    const current = attempt && attempt.resetAt > now
      ? { count: attempt.count + 1, resetAt: attempt.resetAt }
      : { count: 1, resetAt: now + 15 * 60_000 };
    loginAttempts.set(ip, current);
    res.status(401).json({ error: "Invalid credentials or inactive account" });
    return;
  }

  loginAttempts.delete(ip);
  if (!record.includes(":")) {
    await pool.query("UPDATE users SET password_record = $2 WHERE id = $1", [row.id, hashPassword(password)]);
  }
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO auth_sessions (user_id, token_hash, expires_at) " +
    "VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)",
    [row.id, sha256(token), String(SESSION_HOURS)],
  );
  setSessionCookie(res, token);
  res.json({ user: publicProfile(row) });
}));

app.post("/api/auth/logout", requireAuth, asyncRoute(async (req, res) => {
  const token = readCookie(req, COOKIE_NAME);
  if (token) await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [sha256(token)]);
  clearSessionCookie(res);
  res.json({ success: true });
}));

app.get("/api/auth/me", requireAuth, (req: AuthRequest, res) => {
  res.json({ user: req.auth });
});

app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", asyncRoute(async (_req, res) => {
  const result = await pool.query<{ missing: string[] }>(
    "SELECT ARRAY_REMOVE(ARRAY[" +
      "CASE WHEN to_regclass('public.users') IS NULL THEN 'users' END, " +
      "CASE WHEN to_regclass('public.auth_sessions') IS NULL THEN 'auth_sessions' END, " +
      "CASE WHEN to_regclass('public.zones') IS NULL THEN 'zones' END, " +
      "CASE WHEN to_regclass('public.sop_items') IS NULL THEN 'sop_items' END, " +
      "CASE WHEN to_regclass('public.task_instances') IS NULL THEN 'task_instances' END, " +
      "CASE WHEN to_regclass('public.locations') IS NULL THEN 'locations' END, " +
      "CASE WHEN to_regclass('public.firestore_documents') IS NULL THEN 'firestore_documents' END, " +
      "CASE WHEN to_regclass('public.operational_tasks') IS NULL THEN 'operational_tasks' END, " +
      "CASE WHEN to_regclass('public.device_switches') IS NULL THEN 'device_switches' END, " +
      "CASE WHEN to_regclass('public.kpi_snapshots') IS NULL THEN 'kpi_snapshots' END, " +
      "CASE WHEN to_regclass('public.audit_logs') IS NULL THEN 'audit_logs' END" +
    "], NULL) AS missing",
  );
  const missing = result.rows[0]?.missing || [];
  if (missing.length > 0) {
    res.status(503).json({ status: "not_ready", database: "connected", missing });
    return;
  }
  res.json({ status: "ready", database: "connected", schema: "present" });
}));

app.get("/api/users", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query(
    "SELECT id, username, full_name, role, is_active, raw_data " +
    "FROM users ORDER BY full_name",
  );
  res.json({ data: result.rows.map((row) => publicProfile(row)) });
}));

app.get("/api/zones", requireAuth, asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, location_id, name, responsible_employee_id, raw_data FROM zones ORDER BY id");
  res.json({ data: result.rows.map((row) => ({
    ...row.raw_data, id: row.id, location_id: row.location_id, name: row.name,
    responsible_employee_id: row.responsible_employee_id,
  })) });
}));

app.get("/api/locations", requireAuth, asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM locations ORDER BY name, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/operational-tasks", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM operational_tasks ORDER BY title, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/device-switches", requireAuth, asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM device_switches ORDER BY code, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/kpi-snapshots", requireAuth, asyncRoute(async (req, res) => {
  const requestedProfile = typeof req.query.profileId === "string" ? req.query.profileId : null;
  const profileId = req.auth?.role === "cleaner" ? req.auth.id : requestedProfile;
  const values: unknown[] = [];
  let where = "";
  if (profileId) {
    values.push(profileId);
    where = " WHERE profile_id = $" + values.length;
  }
  values.push(100);
  const result = await pool.query(
    "SELECT id, raw_data FROM kpi_snapshots" + where +
      " ORDER BY period_end DESC NULLS LAST, id LIMIT $" + values.length,
    values,
  );
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/audit-logs", requireAuth, asyncRoute(async (req, res) => {
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const rawOffset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500 ||
      !Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 1000000) {
    res.status(400).json({ error: "limit must be 1-500 and offset must be 0-1000000" }); return;
  }
  const values: unknown[] = [];
  let where = "";
  if (req.auth?.role === "cleaner") {
    values.push(req.auth.id);
    where = " WHERE EXISTS (SELECT 1 FROM task_instances t WHERE t.id = audit_logs.task_id AND t.assigned_to = $1)";
  }
  values.push(rawLimit);
  const limitParameter = values.length;
  values.push(rawOffset);
  const offsetParameter = values.length;
  const result = await pool.query(
    "SELECT id, task_id, action, metadata, raw_data, created_at FROM audit_logs" +
      where + " ORDER BY created_at DESC NULLS LAST, id LIMIT $" + limitParameter +
      " OFFSET $" + offsetParameter,
    values,
  );
  res.json({
    data: result.rows.map((row) => ({
      ...row.raw_data, id: row.id, task_id: row.task_id,
      action: row.action, metadata: row.metadata, created_at: row.created_at,
    })),
    meta: { limit: rawLimit, offset: rawOffset },
  });
}));

app.get("/api/sop-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM sop_items ORDER BY id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.post("/api/tasks", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const zoneId = typeof body.zone_id === "string" ? body.zone_id : "z_reception";
  const dueDate = typeof body.due_date === "string" ? body.due_date : getBusinessDate();
  const dueTime = typeof body.due_time === "string" ? body.due_time : "12:00";
  if (!title || title.length > 300) {
    res.status(400).json({ error: "A task title is required (maximum 300 characters)" }); return;
  }
  if (!isValidDateOnly(dueDate)) {
    res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" }); return;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) {
    res.status(400).json({ error: "due_time must use HH:MM" }); return;
  }
  const taskType = typeof body.task_type === "string" ? body.task_type : "one_time";
  if (!["one_time", "recurring", "rework"].includes(taskType)) {
    res.status(400).json({ error: "Unsupported task type" }); return;
  }
  if (taskType === "rework" && typeof body.parent_instance_id !== "string") {
    res.status(400).json({ error: "Rework tasks require parent_instance_id" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [zoneId]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown task zone" }); return;
    }

    let assignedTo = typeof body.assigned_to === "string" ? body.assigned_to : "";
    if (assignedTo) {
      const eligible = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [assignedTo],
      );
      if (eligible.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Tasks can only be assigned to active cleaners" }); return;
      }
    } else {
      const best = await client.query(
        "SELECT u.id FROM users u LEFT JOIN task_instances t " +
        "ON t.assigned_to = u.id AND t.due_date = $1::date " +
        "WHERE u.role = 'cleaner' AND u.is_active = TRUE " +
        "GROUP BY u.id ORDER BY COUNT(t.id), u.id LIMIT 1",
        [dueDate],
      );
      if (best.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "No active cleaners are available" }); return;
      }
      assignedTo = String(best.rows[0].id);
    }

    const now = new Date().toISOString();
    const id = "ti_" + randomBytes(8).toString("hex");
    const task: Record<string, unknown> = {
      id,
      template_id: typeof body.template_id === "string" ? body.template_id : null,
      sop_item_id: typeof body.sop_item_id === "string" ? body.sop_item_id : null,
      zone_id: zoneId,
      assigned_to: assignedTo,
      assigned_by: req.auth?.id || "p1",
      task_type: taskType,
      parent_instance_id: typeof body.parent_instance_id === "string" ? body.parent_instance_id : null,
      title,
      description: typeof body.description === "string" ? body.description : "",
      due_date: dueDate,
      due_time: dueTime,
      status: "pending",
      goal: typeof body.goal === "string" ? body.goal : "",
      task_code: typeof body.task_code === "string" ? body.task_code : "",
      category: typeof body.category === "string" ? body.category : "تشغيل",
      tools_required: typeof body.tools_required === "string" ? body.tools_required : "",
      estimated_duration_minutes: Number.isFinite(Number(body.estimated_duration_minutes))
        ? Number(body.estimated_duration_minutes) : 0,
      requires_photo_before: typeof body.requires_photo_before === "boolean" ? body.requires_photo_before : true,
      requires_photo_after: typeof body.requires_photo_after === "boolean" ? body.requires_photo_after : true,
      requires_supervisor_approval: typeof body.requires_supervisor_approval === "boolean"
        ? body.requires_supervisor_approval : true,
      requires_gps: body.requires_gps === true,
      requires_signature: false,
      supervisor_approved: false,
      created_at: now,
      updated_at: now,
    };
    await client.query(
      "INSERT INTO task_instances (id, template_id, sop_item_id, zone_id, assigned_to, assigned_by, " +
      "task_type, parent_instance_id, title, description, due_date, due_time, status, raw_data, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14::jsonb,$15::timestamptz,$16::timestamptz)",
      [id, task.template_id, task.sop_item_id, zoneId, assignedTo, task.assigned_by,
        taskType, task.parent_instance_id, title, task.description, dueDate, dueTime,
        "pending", JSON.stringify(task), now, now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
      "VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)",
      [auditId, id, "task_created",
        JSON.stringify({ task_type: taskType, assigned_to: assignedTo, due_date: dueDate, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, task_id: id, action: "task_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.status(201).json({ data: task });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/tasks/:id/approve", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const grade = req.body?.quality_grade;
  if (!["A", "B", "C"].includes(grade)) {
    res.status(400).json({ error: "quality_grade must be A, B or C" }); return;
  }
  const notes = typeof req.body?.supervisor_notes === "string" ? req.body.supervisor_notes : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id, raw_data, assigned_to, zone_id, due_date, due_time, status " +
      "FROM task_instances WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Task not found" }); return;
    }
    const row = selected.rows[0];
    if (row.status !== "completed") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Only completed tasks can be approved" }); return;
    }
    const now = new Date().toISOString();
    const task = {
      ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
      id: row.id, assigned_to: row.assigned_to, zone_id: row.zone_id,
      due_date: String(row.due_date).slice(0, 10), due_time: row.due_time, status: row.status,
      supervisor_approved: true, supervisor_approved_by: req.auth?.id,
      supervisor_approved_at: now, quality_grade: grade, supervisor_notes: notes, updated_at: now,
    };
    await client.query(
      "UPDATE task_instances SET raw_data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1",
      [req.params.id, JSON.stringify(task), now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
      "VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)",
      [auditId, req.params.id, "task_approved",
        JSON.stringify({ supervisor_id: req.auth?.id, quality_grade: grade, supervisor_notes: notes }),
        JSON.stringify({ id: auditId, task_id: req.params.id, action: "task_approved", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ data: task });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/tasks/:id/reject", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const notes = typeof req.body?.supervisor_notes === "string" ? req.body.supervisor_notes : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id, raw_data, assigned_to, zone_id, due_date, due_time, status, template_id " +
      "FROM task_instances WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Task not found" }); return;
    }
    const row = selected.rows[0];
    if (row.status === "rejected") {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "Task has already been rejected" }); return;
    }

    const now = new Date().toISOString();
    const today = getBusinessDate();
    const original = {
      ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
      id: row.id, assigned_to: row.assigned_to, zone_id: row.zone_id,
      due_date: String(row.due_date).slice(0, 10), due_time: row.due_time,
      status: "rejected", supervisor_approved: false,
      supervisor_approved_by: req.auth?.id, supervisor_approved_at: now,
      supervisor_notes: notes || "مرفوضة وتحتاج لإعادة التنظيف", updated_at: now,
    };

    let reworkAssignee = String(row.assigned_to || "");
    let eligible = await client.query(
      "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
      [reworkAssignee],
    );
    if (eligible.rowCount !== 1) {
      const zone = await client.query("SELECT responsible_employee_id FROM zones WHERE id = $1", [row.zone_id]);
      const responsibleId = zone.rows[0]?.responsible_employee_id;
      eligible = responsibleId ? await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [responsibleId],
      ) : { rows: [], rowCount: 0 } as typeof eligible;
      if (eligible.rowCount === 1) {
        reworkAssignee = String(eligible.rows[0].id);
      } else {
        const best = await client.query(
          "SELECT u.id FROM users u LEFT JOIN task_instances t " +
          "ON t.assigned_to = u.id AND t.due_date = $1::date " +
          "WHERE u.role = 'cleaner' AND u.is_active = TRUE " +
          "GROUP BY u.id ORDER BY COUNT(t.id), u.id LIMIT 1",
          [today],
        );
        if (best.rowCount !== 1) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "No active cleaners are available for rework" }); return;
        }
        reworkAssignee = String(best.rows[0].id);
      }
    }

    const reworkId = "ti_rework_" + randomBytes(8).toString("hex");
    const rework = {
      id: reworkId,
      template_id: row.template_id,
      zone_id: row.zone_id,
      assigned_to: reworkAssignee,
      assigned_by: req.auth?.id || "p1",
      task_type: "rework",
      parent_instance_id: row.id,
      title: "إعادة تنظيف: " + String(original.title || "المهمة") + " ⚠️",
      description: "سبب الرفض: " + (notes || "ملاحظات المشرف") +
        ". يرجى إعادة التنظيف بالكامل والتقاط صور واضحة بعد الانتهاء.",
      due_date: today,
      due_time: "17:00",
      status: "pending",
      supervisor_approved: false,
      created_at: now,
      updated_at: now,
    };
    await client.query(
      "UPDATE task_instances SET status = 'rejected', raw_data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1",
      [req.params.id, JSON.stringify(original), now],
    );
    await client.query(
      "INSERT INTO task_instances (id, template_id, zone_id, assigned_to, assigned_by, task_type, " +
      "parent_instance_id, title, description, due_date, due_time, status, raw_data, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,'rework',$6,$7,$8,$9::date,$10,$11,$12::jsonb,$13::timestamptz,$14::timestamptz)",
      [reworkId, row.template_id, row.zone_id, reworkAssignee, rework.assigned_by, row.id,
        rework.title, rework.description, today, "17:00", "pending", JSON.stringify(rework), now, now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
      "VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)",
      [auditId, req.params.id, "task_rejected_rework_created",
        JSON.stringify({ rework_task_id: reworkId, supervisor_id: req.auth?.id,
          rework_assigned_to: reworkAssignee, supervisor_notes: notes }),
        JSON.stringify({ id: auditId, task_id: req.params.id, action: "task_rejected_rework_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ data: { original, rework } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/tasks/:id", requireAuth, asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const cleanerFields = new Set([
    "status", "employee_notes", "employee_signature_url",
    "photo_before_url", "photo_after_url",
    "photo_before_taken_at", "photo_before_uploaded_at",
    "photo_after_taken_at", "photo_after_uploaded_at",
    "photo_before_size", "photo_after_size",
    "photo_before_mime_type", "photo_after_mime_type",
    "photo_capture_status",
  ]);
  const supervisorFields = new Set([
    ...cleanerFields,
    "assigned_to", "title", "description", "zone_id", "due_date", "due_time",
    "goal", "requires_photo_before", "requires_photo_after",
    "requires_supervisor_approval", "requires_gps", "estimated_duration_minutes",
    "supervisor_notes",
  ]);
  const allowed = req.auth?.role === "cleaner" ? cleanerFields : supervisorFields;
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
    updates[key] = value;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "At least one task field must be provided" }); return;
  }
  if (updates.status !== undefined &&
      !["pending", "in_progress", "completed", "late", "escalated"].includes(String(updates.status))) {
    res.status(400).json({ error: "Unsupported task status" }); return;
  }
  if (updates.due_date !== undefined &&
      (typeof updates.due_date !== "string" || !isValidDateOnly(updates.due_date))) {
    res.status(400).json({ error: "due_date must be a valid YYYY-MM-DD date" }); return;
  }
  if (updates.due_time !== undefined &&
      (typeof updates.due_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(updates.due_time))) {
    res.status(400).json({ error: "due_time must use HH:MM" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id, raw_data, assigned_to, assigned_by, zone_id, due_date, due_time, status " +
      "FROM task_instances WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Task not found" }); return;
    }
    const row = selected.rows[0];
    if (req.auth?.role === "cleaner" && row.assigned_to !== req.auth.id) {
      await client.query("ROLLBACK");
      res.status(403).json({ error: "You can only update tasks assigned to you" }); return;
    }
    const current = {
      ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
      id: row.id,
      assigned_to: row.assigned_to,
      assigned_by: row.assigned_by,
      zone_id: row.zone_id,
      due_date: String(row.due_date).slice(0, 10),
      due_time: row.due_time,
      status: row.status,
    } as TaskRecord & Record<string, unknown>;

    if (req.auth?.role === "cleaner" && updates.status !== undefined) {
      const allowedTransition =
        (current.status === "pending" && updates.status === "in_progress") ||
        (current.status === "in_progress" && updates.status === "completed");
      if (!allowedTransition) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Invalid task status transition" }); return;
      }
    }

    if (typeof updates.assigned_to === "string" && updates.assigned_to !== current.assigned_to) {
      const assignee = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [updates.assigned_to],
      );
      if (assignee.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Tasks can only be assigned to active cleaners" }); return;
      }
    }

    const now = new Date().toISOString();
    const merged = applyTaskUpdate(current, updates as Partial<TaskRecord>, now);
    const result = await client.query(
      "UPDATE task_instances SET assigned_to = $2, zone_id = $3, due_date = $4::date, " +
      "due_time = $5, status = $6, title = $7, description = $8, " +
      "raw_data = $9::jsonb, updated_at = $10::timestamptz WHERE id = $1 RETURNING id",
      [req.params.id, merged.assigned_to, merged.zone_id, merged.due_date,
        merged.due_time, merged.status, merged.title, merged.description, JSON.stringify(merged), now],
    );
    if (result.rowCount !== 1) throw new Error("Task update did not affect exactly one row");

    const changedFields = Object.keys(updates);
    const action = changedFields.some((field) => field.startsWith("photo_"))
      ? "task_photo_updated"
      : changedFields.includes("assigned_to")
        ? "task_reassigned"
        : changedFields.includes("status")
          ? "task_status_" + String(updates.status)
          : "task_updated";
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
      "VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz)",
      [auditId, req.params.id, action,
        JSON.stringify({
          changed_fields: changedFields,
          status_before: current.status,
          status_after: merged.status,
          assigned_to_before: current.assigned_to,
          assigned_to_after: merged.assigned_to,
          actor_id: req.auth?.id,
        }),
        JSON.stringify({ id: auditId, task_id: req.params.id, action, created_at: now }),
        now],
    );
    await client.query("COMMIT");
    res.json({ data: merged });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : null;
  const start = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const end = typeof req.query.endDate === "string" ? req.query.endDate : null;
  if (date && !isValidDateOnly(date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" }); return;
  }
  if ((start && !isValidDateOnly(start)) || (end && !isValidDateOnly(end))) {
    res.status(400).json({ error: "Date range must use YYYY-MM-DD" }); return;
  }
  if ((start && !end) || (!start && end)) {
    res.status(400).json({ error: "startDate and endDate must be provided together" }); return;
  }
  if (start && end && start > end) {
    res.status(400).json({ error: "startDate must not be after endDate" }); return;
  }
  if (start && end) {
    const days = (Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86_400_000;
    if (!Number.isFinite(days) || days > 366) {
      res.status(400).json({ error: "Date range cannot exceed 366 days" }); return;
    }
  }
  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
  const rawOffset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500 ||
      !Number.isInteger(rawOffset) || rawOffset < 0 || rawOffset > 1_000_000) {
    res.status(400).json({ error: "limit must be 1-500 and offset must be 0-1000000" }); return;
  }
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (date) { values.push(date); clauses.push("due_date = $" + values.length + "::date"); }
  else if (start && end) {
    values.push(start); clauses.push("due_date >= $" + values.length + "::date");
    values.push(end); clauses.push("due_date <= $" + values.length + "::date");
  }
  if (req.auth?.role === "cleaner") {
    values.push(req.auth.id); clauses.push("assigned_to = $" + values.length);
  }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  values.push(rawLimit);
  const limitParameter = values.length;
  values.push(rawOffset);
  const offsetParameter = values.length;
  const result = await pool.query(
    "SELECT id, raw_data, assigned_to, due_date, due_time, status FROM task_instances" +
    where + " ORDER BY due_date, due_time NULLS LAST, id LIMIT $" + limitParameter +
    " OFFSET $" + offsetParameter,
    values,
  );
  res.json({
    data: result.rows.map((row) => ({
      ...row.raw_data, id: row.id, assigned_to: row.assigned_to,
      due_date: String(row.due_date).slice(0, 10), due_time: row.due_time, status: row.status,
    })),
    meta: { limit: rawLimit, offset: rawOffset },
  });
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  // Never return SQL, credentials, stack traces, or database details to clients.
  console.error("[API]", message);
  res.status(500).json({ error: "Internal server error" });
});

async function start(): Promise<void> {
  assertNarisDatabaseUrl(process.env.DATABASE_URL);
  await pool.query("SELECT 1");
  const server = app.listen(PORT, "0.0.0.0", () => {
    process.stdout.write("Naris Ops API listening on port " + PORT + "\n");
  });
  const shutdown = (signal: string) => {
    process.stdout.write(signal + " received; shutting down API.\n");
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
start().catch((error: unknown) => {
  console.error("API startup failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
