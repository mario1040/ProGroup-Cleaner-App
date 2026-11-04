import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { assertNarisDatabaseUrl } from "./db/connection";
import { applyTaskUpdate, type TaskRecord } from "./task-rules";
import { generateRecurringTasksForDate } from "./task-generator";

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

function dateOnly(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") return value.slice(0, 10);
  return "";
}

async function upsertTaskMediaRecord(
  client: PoolClient,
  taskId: string,
  task: Record<string, unknown>,
  side: "before" | "after",
): Promise<void> {
  const prefix = side === "before" ? "photo_before" : "photo_after";
  const secureUrl = task[prefix + "_url"];
  if (typeof secureUrl !== "string" || !secureUrl.startsWith("https://")) return;
  const publicId = typeof task[prefix + "_public_id"] === "string" ? task[prefix + "_public_id"] : null;
  const provider = secureUrl.includes("res.cloudinary.com") ? "cloudinary" : "legacy_external";
  const byteSize = task[prefix + "_size"];
  await client.query(
    "INSERT INTO task_media (task_id, side, storage_provider, public_id, secure_url, mime_type, byte_size, captured_at, uploaded_at, metadata) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10::jsonb) " +
    "ON CONFLICT (task_id, side) DO UPDATE SET storage_provider = EXCLUDED.storage_provider, " +
    "public_id = COALESCE(EXCLUDED.public_id, task_media.public_id), secure_url = EXCLUDED.secure_url, " +
    "mime_type = EXCLUDED.mime_type, byte_size = EXCLUDED.byte_size, captured_at = EXCLUDED.captured_at, " +
    "uploaded_at = EXCLUDED.uploaded_at, metadata = EXCLUDED.metadata, updated_at = NOW()",
    [taskId, side, provider, publicId, secureUrl, task[prefix + "_mime_type"] || null,
      Number.isSafeInteger(byteSize) ? byteSize : null,
      task[prefix + "_taken_at"] || null, task[prefix + "_uploaded_at"] || null,
      JSON.stringify({ source: "task_update", side })],
  );
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
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
      "CASE WHEN to_regclass('public.task_templates') IS NULL THEN 'task_templates' END, " +
      "CASE WHEN to_regclass('public.task_instances') IS NULL THEN 'task_instances' END, " +
      "CASE WHEN to_regclass('public.task_media') IS NULL THEN 'task_media' END, " +
      "CASE WHEN to_regclass('public.locations') IS NULL THEN 'locations' END, " +
      "CASE WHEN to_regclass('public.firestore_documents') IS NULL THEN 'firestore_documents' END, " +
      "CASE WHEN to_regclass('public.operational_tasks') IS NULL THEN 'operational_tasks' END, " +
      "CASE WHEN to_regclass('public.device_switches') IS NULL THEN 'device_switches' END, " +
      "CASE WHEN to_regclass('public.kpi_snapshots') IS NULL THEN 'kpi_snapshots' END, " +
      "CASE WHEN to_regclass('public.audit_logs') IS NULL THEN 'audit_logs' END, " +
      "CASE WHEN to_regclass('public.inventory_items') IS NULL THEN 'inventory_items' END" +
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

app.post("/api/users", requireAuth, allowRoles("admin"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const role = body.role;
  if (!username || !fullName || !["admin", "supervisor", "cleaner"].includes(String(role))) {
    res.status(400).json({ error: "username, full_name and a valid role are required" }); return;
  }
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") {
    res.status(400).json({ error: "is_active must be boolean" }); return;
  }
  if (typeof body.phone === "string" && body.phone.length > 40) {
    res.status(400).json({ error: "phone is too long" }); return;
  }
  const suppliedPassword = typeof body.password === "string" ? body.password : "";
  if (suppliedPassword && suppliedPassword.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" }); return;
  }
  const generatedPassword = suppliedPassword || randomBytes(12).toString("base64url");
  const id = "p_" + randomBytes(8).toString("hex");
  const now = new Date().toISOString();
  const raw: Record<string, unknown> = { ...body, id, username, full_name: fullName, role, is_active: body.is_active !== false, created_at: now };
  delete raw.password;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO users (id, username, full_name, phone, role, is_active, password_record, raw_data, created_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)",
      [id, username, fullName, typeof body.phone === "string" ? body.phone : null, role,
        raw.is_active, hashPassword(generatedPassword), JSON.stringify(raw), now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "user_created", JSON.stringify({ user_id: id, role, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "user_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.status(201).json({ profile: publicProfile({ ...raw, ...{ id, username, full_name: fullName, role, is_active: raw.is_active, raw_data: raw } }), generatedPassword });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.includes("users_username_ci_uq")) {
      res.status(409).json({ error: "Username is already in use" }); return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/users/:id/reset-password", requireAuth, allowRoles("admin"), asyncRoute(async (req, res) => {
  const generatedPassword = randomBytes(12).toString("base64url");
  const now = new Date().toISOString();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT id, raw_data FROM users WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "User not found" }); return;
    }
    const current = selected.rows[0].raw_data && typeof selected.rows[0].raw_data === "object"
      ? selected.rows[0].raw_data as Record<string, unknown> : {};
    const updated: Record<string, unknown> = { ...current, updated_at: now };
    delete updated.password;
    await client.query(
      "UPDATE users SET password_record = $2, raw_data = $3::jsonb, updated_at = $4::timestamptz WHERE id = $1",
      [req.params.id, hashPassword(generatedPassword), JSON.stringify(updated), now],
    );
    await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [req.params.id]);
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "user_password_reset", JSON.stringify({ user_id: req.params.id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "user_password_reset", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ generatedPassword });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/users/:id", requireAuth, allowRoles("admin"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set([
    "username", "full_name", "role", "phone", "avatar_url", "is_active",
    "shift_start", "shift_end", "work_days", "password", "created_at", "updated_at",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  if (body.role !== undefined && !["admin", "supervisor", "cleaner"].includes(String(body.role))) {
    res.status(400).json({ error: "Unsupported user role" }); return;
  }
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") {
    res.status(400).json({ error: "is_active must be boolean" }); return;
  }
  if (body.username !== undefined && (typeof body.username !== "string" || !body.username.trim())) {
    res.status(400).json({ error: "username cannot be empty" }); return;
  }
  if (body.full_name !== undefined && (typeof body.full_name !== "string" || !body.full_name.trim())) {
    res.status(400).json({ error: "full_name cannot be empty" }); return;
  }
  if (body.work_days !== undefined && !Array.isArray(body.work_days)) {
    res.status(400).json({ error: "work_days must be an array" }); return;
  }
  if (body.password !== undefined &&
      (typeof body.password !== "string" || body.password.length < 6)) {
    res.status(400).json({ error: "Password must be at least 6 characters" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id, username, full_name, role, is_active, password_record, raw_data FROM users WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "User not found" }); return;
    }
    const row = selected.rows[0];
    const current = row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {};
    const merged = { ...current, ...body, id: row.id, updated_at: new Date().toISOString() } as Record<string, unknown>;
    delete merged.password;
    const passwordRecord = typeof body.password === "string" ? hashPassword(body.password) : row.password_record;
    await client.query(
      "UPDATE users SET username = $2, full_name = $3, phone = $4, role = $5, is_active = $6, " +
      "password_record = $7, raw_data = $8::jsonb, updated_at = $9::timestamptz WHERE id = $1",
      [req.params.id, merged.username || row.username, merged.full_name || row.full_name,
        typeof merged.phone === "string" ? merged.phone : null, merged.role || row.role,
        merged.is_active !== false, passwordRecord, JSON.stringify(merged), merged.updated_at],
    );
    if (merged.is_active === false) {
      await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [req.params.id]);
    }
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "user_updated", JSON.stringify({ user_id: req.params.id, changed_fields: Object.keys(body), actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "user_updated", created_at: merged.updated_at }), merged.updated_at],
    );
    await client.query("COMMIT");
    const profile = publicProfile({
      id: req.params.id,
      username: merged.username || row.username,
      full_name: merged.full_name || row.full_name,
      role: merged.role || row.role,
      is_active: merged.is_active !== false,
      raw_data: merged,
    });
    res.json({ profile });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.includes("users_username_ci_uq")) {
      res.status(409).json({ error: "Username is already in use" }); return;
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.post("/api/users/:id/reassign-pending", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inactive = await client.query(
      "SELECT id, role, is_active FROM users WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (inactive.rowCount !== 1 || inactive.rows[0].role !== "cleaner" || inactive.rows[0].is_active === true) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "The selected account must be an inactive cleaner" }); return;
    }
    const pending = await client.query(
      "SELECT id, raw_data, assigned_to, assigned_by, due_date, due_time, status " +
      "FROM task_instances WHERE assigned_to = $1 AND status = 'pending' " +
      "ORDER BY due_date, due_time NULLS LAST, id FOR UPDATE",
      [req.params.id],
    );
    if (pending.rowCount === 0) {
      await client.query("COMMIT");
      res.json({ updated: 0, skipped: 0 }); return;
    }
    const cleaners = await client.query(
      "SELECT id FROM users WHERE role = 'cleaner' AND is_active = TRUE ORDER BY id",
    );
    if (cleaners.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "No active cleaners are available for reassignment" }); return;
    }
    const cleanerIds = cleaners.rows.map((row) => String(row.id));
    const dates = [...new Set(pending.rows.map((row) => dateOnly(row.due_date)))];
    const workload = new Map<string, Map<string, number>>();
    for (const date of dates) {
      const counts = await client.query(
        "SELECT assigned_to, COUNT(*)::int AS task_count FROM task_instances " +
        "WHERE due_date = $1::date GROUP BY assigned_to",
        [date],
      );
      const day = new Map<string, number>();
      for (const row of counts.rows) day.set(String(row.assigned_to), Number(row.task_count));
      workload.set(date, day);
    }
    const now = new Date().toISOString();
    for (const row of pending.rows) {
      const date = dateOnly(row.due_date);
      const day = workload.get(date) || new Map<string, number>();
      const selected = [...cleanerIds].sort((left, right) =>
        (day.get(left) || 0) - (day.get(right) || 0) || left.localeCompare(right)
      )[0];
      const task = {
        ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
        id: row.id,
        assigned_to: selected,
        assigned_by: "p1",
        updated_at: now,
      };
      await client.query(
        "UPDATE task_instances SET assigned_to = $2, assigned_by = $3, raw_data = $4::jsonb, " +
        "updated_at = $5::timestamptz WHERE id = $1",
        [row.id, selected, "p1", JSON.stringify(task), now],
      );
      day.set(selected, (day.get(selected) || 0) + 1);
      workload.set(date, day);
      const auditId = "audit_" + randomBytes(12).toString("hex");
      await client.query(
        "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
        "VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)",
        [auditId, row.id, "task_reassigned",
          JSON.stringify({
            changed_fields: ["assigned_to", "assigned_by"],
            assigned_to_before: req.params.id,
            assigned_to_after: selected,
            actor_id: req.auth?.id,
          }),
          JSON.stringify({ id: auditId, task_id: row.id, action: "task_reassigned", created_at: now }), now],
      );
    }
    await client.query("COMMIT");
    res.json({ updated: pending.rowCount, skipped: 0 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

app.post("/api/zones", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const locationId = typeof body.location_id === "string" ? body.location_id : "";
  if (!name || !locationId) {
    res.status(400).json({ error: "name and location_id are required" }); return;
  }
  if (body.sort_order !== undefined && !Number.isFinite(Number(body.sort_order))) {
    res.status(400).json({ error: "sort_order must be numeric" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const location = await client.query("SELECT id FROM locations WHERE id = $1", [locationId]);
    if (location.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown location" }); return;
    }
    const responsibleId = typeof body.responsible_employee_id === "string" ? body.responsible_employee_id : null;
    if (responsibleId) {
      const user = await client.query("SELECT id FROM users WHERE id = $1", [responsibleId]);
      if (user.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Unknown responsible employee" }); return;
      }
    }
    const id = "z_" + randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    const zone = { ...body, id, name, location_id: locationId, responsible_employee_id: responsibleId, created_at: now };
    await client.query(
      "INSERT INTO zones (id, location_id, name, responsible_employee_id, raw_data) VALUES ($1,$2,$3,$4,$5::jsonb)",
      [id, locationId, name, responsibleId, JSON.stringify(zone)],
    );
    await client.query("COMMIT");
    res.status(201).json({ data: zone });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/zones/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set(["name", "location_id", "code", "floor", "responsible_employee_id", "cover_image_url", "sort_order", "created_at", "updated_at"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT id, raw_data FROM zones WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Zone not found" }); return;
    }
    const current = selected.rows[0].raw_data && typeof selected.rows[0].raw_data === "object"
      ? selected.rows[0].raw_data as Record<string, unknown> : {};
    const zone: Record<string, unknown> = { ...current, ...body, id: req.params.id };
    if (typeof zone.name !== "string" || !zone.name.trim() || typeof zone.location_id !== "string") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Zone name and location_id are required" }); return;
    }
    const location = await client.query("SELECT id FROM locations WHERE id = $1", [zone.location_id]);
    if (location.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown location" }); return;
    }
    if (typeof zone.responsible_employee_id === "string" && zone.responsible_employee_id) {
      const user = await client.query("SELECT id FROM users WHERE id = $1", [zone.responsible_employee_id]);
      if (user.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Unknown responsible employee" }); return;
      }
    }
    await client.query(
      "UPDATE zones SET location_id = $2, name = $3, responsible_employee_id = $4, raw_data = $5::jsonb WHERE id = $1",
      [req.params.id, zone.location_id, zone.name, zone.responsible_employee_id || null, JSON.stringify(zone)],
    );
    await client.query("COMMIT");
    res.json({ data: zone });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/operational-tasks", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM operational_tasks ORDER BY title, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/device-switches", requireAuth, asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM device_switches ORDER BY code, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));


const inventoryCategories = new Set(["معدات تنظيف", "مواد كيميائية", "مستهلكات", "أخرى"]);
function getInventoryStatus(quantity: number, minQuantity: number): "متوفر" | "منخفض" | "نفد" {
  if (quantity === 0) return "نفد";
  return quantity <= minQuantity ? "منخفض" : "متوفر";
}

app.get("/api/inventory-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query(
    "SELECT id, name, category, quantity, min_quantity, status, updated_at FROM inventory_items ORDER BY category, name, id",
  );
  res.json({ data: result.rows.map((row) => ({
    id: row.id, name: row.name, category: row.category,
    quantity: Number(row.quantity), min_quantity: Number(row.min_quantity),
    status: row.status, last_updated: row.updated_at,
  })) });
}));

app.post("/api/inventory-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const category = typeof body.category === "string" ? body.category : "";
  const quantity = Number(body.quantity);
  const minQuantity = body.min_quantity === undefined ? 5 : Number(body.min_quantity);
  if (!name || name.length > 160 || !inventoryCategories.has(category)) {
    res.status(400).json({ error: "A valid name and inventory category are required" }); return;
  }
  if (!Number.isSafeInteger(quantity) || quantity < 0 ||
      !Number.isSafeInteger(minQuantity) || minQuantity < 0) {
    res.status(400).json({ error: "quantity and min_quantity must be non-negative integers" }); return;
  }
  const id = "inv_" + randomBytes(10).toString("hex");
  const now = new Date().toISOString();
  const status = getInventoryStatus(quantity, minQuantity);
  const item = { id, name, category, quantity, min_quantity: minQuantity, status, last_updated: now };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO inventory_items (id, name, category, quantity, min_quantity, status, raw_data, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$8::timestamptz)",
      [id, name, category, quantity, minQuantity, status, JSON.stringify(item), now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "inventory_item_created", JSON.stringify({ inventory_item_id: id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "inventory_item_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.status(201).json({ data: item });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/inventory-items/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const allowed = new Set(["name", "category", "quantity", "min_quantity"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 160)) {
    res.status(400).json({ error: "name must be a non-empty string up to 160 characters" }); return;
  }
  if (body.category !== undefined && (typeof body.category !== "string" || !inventoryCategories.has(body.category))) {
    res.status(400).json({ error: "Unsupported inventory category" }); return;
  }
  for (const key of ["quantity", "min_quantity"]) {
    const value = body[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
      res.status(400).json({ error: key + " must be a non-negative integer" }); return;
    }
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "At least one inventory field must be provided" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id, name, category, quantity, min_quantity FROM inventory_items WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Inventory item not found" }); return;
    }
    const row = selected.rows[0];
    const name = typeof body.name === "string" ? body.name.trim() : String(row.name);
    const category = typeof body.category === "string" ? body.category : String(row.category);
    const quantity = body.quantity === undefined ? Number(row.quantity) : Number(body.quantity);
    const minQuantity = body.min_quantity === undefined ? Number(row.min_quantity) : Number(body.min_quantity);
    const status = getInventoryStatus(quantity, minQuantity);
    const now = new Date().toISOString();
    const item = { id: String(row.id), name, category, quantity, min_quantity: minQuantity, status, last_updated: now };
    await client.query(
      "UPDATE inventory_items SET name=$2, category=$3, quantity=$4, min_quantity=$5, status=$6, raw_data=$7::jsonb, updated_at=$8::timestamptz WHERE id=$1",
      [row.id, name, category, quantity, minQuantity, status, JSON.stringify(item), now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "inventory_item_updated", JSON.stringify({ inventory_item_id: row.id, changed_fields: Object.keys(body), actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "inventory_item_updated", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ data: item });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/inventory-items/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE",
      [req.params.id],
    );
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Inventory item not found" }); return;
    }
    await client.query("DELETE FROM inventory_items WHERE id = $1", [req.params.id]);
    const now = new Date().toISOString();
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "inventory_item_deleted", JSON.stringify({ inventory_item_id: req.params.id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "inventory_item_deleted", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/kpis", requireAuth, asyncRoute(async (req, res) => {
  let startDate = typeof req.query.startDate === "string" ? req.query.startDate : "";
  let endDate = typeof req.query.endDate === "string" ? req.query.endDate : "";
  if (!startDate && !endDate) {
    const today = getBusinessDate();
    const [year, month] = today.split("-").map(Number);
    startDate = String(year) + "-" + String(month).padStart(2, "0") + "-01";
    const nextMonth = new Date(Date.UTC(year, month, 1));
    endDate = nextMonth.getUTCFullYear() + "-" +
      String(nextMonth.getUTCMonth() + 1).padStart(2, "0") + "-01";
  }
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate) || startDate > endDate) {
    res.status(400).json({ error: "Valid startDate and endDate are required" }); return;
  }
  const span = (Date.parse(endDate + "T00:00:00Z") - Date.parse(startDate + "T00:00:00Z")) / 86400000;
  if (span > 366) {
    res.status(400).json({ error: "KPI date range cannot exceed 366 days" }); return;
  }
  const values: unknown[] = [startDate, endDate];
  let cleanerFilter = "";
  if (req.auth?.role === "cleaner") {
    values.push(req.auth.id);
    cleanerFilter = " AND u.id = $" + values.length;
  }
  const result = await pool.query(
    "SELECT u.id AS profile_id, u.full_name AS cleaner_name, u.username, " +
    "COUNT(t.id)::int AS tasks_assigned, " +
    "COUNT(t.id) FILTER (WHERE t.status = 'completed' AND COALESCE((t.raw_data->>'supervisor_approved')::boolean, FALSE))::int AS completed_approved, " +
    "COUNT(t.id) FILTER (WHERE t.status = 'completed' AND COALESCE((t.raw_data->>'supervisor_approved')::boolean, FALSE) AND COALESCE(NULLIF(t.raw_data->>'delay_minutes','')::numeric,0) <= 0)::int AS tasks_completed_on_time, " +
    "COUNT(t.id) FILTER (WHERE t.status = 'completed' AND COALESCE(NULLIF(t.raw_data->>'delay_minutes','')::numeric,0) > 0)::int AS tasks_late, " +
    "COUNT(t.id) FILTER (WHERE t.task_type = 'rework')::int AS tasks_reworked, " +
    "COUNT(t.id) FILTER (WHERE t.status = 'rejected')::int AS tasks_rejected, " +
    "COALESCE(AVG(EXTRACT(EPOCH FROM ((t.raw_data->>'completed_at')::timestamptz - (t.raw_data->>'started_at')::timestamptz))/60.0) " +
    "FILTER (WHERE NULLIF(t.raw_data->>'started_at','') IS NOT NULL AND NULLIF(t.raw_data->>'completed_at','') IS NOT NULL " +
    "AND (t.raw_data->>'completed_at')::timestamptz > (t.raw_data->>'started_at')::timestamptz),0) AS avg_execution_time_minutes, " +
    "COALESCE(AVG(CASE t.raw_data->>'quality_grade' WHEN 'A' THEN 100.0 WHEN 'B' THEN 80.0 WHEN 'C' THEN 60.0 END),0) AS quality_score " +
    "FROM users u LEFT JOIN task_instances t ON t.assigned_to = u.id AND t.due_date >= $1::date AND t.due_date <= $2::date " +
    "WHERE u.role = 'cleaner'" + cleanerFilter +
    " GROUP BY u.id, u.full_name, u.username",
    values,
  );
  const data = result.rows.map((row) => {
    const completed = Number(row.completed_approved || 0);
    const onTime = Number(row.tasks_completed_on_time || 0);
    const quality = Math.round(Number(row.quality_score || 0));
    return {
      profile_id: row.profile_id,
      cleaner_name: row.cleaner_name,
      username: row.username,
      tasks_assigned: Number(row.tasks_assigned || 0),
      tasks_completed_on_time: onTime,
      tasks_late: Number(row.tasks_late || 0),
      tasks_reworked: Number(row.tasks_reworked || 0),
      tasks_rejected: Number(row.tasks_rejected || 0),
      compliance_rate: completed > 0 ? Math.round((onTime / completed) * 100) : 0,
      avg_execution_time_minutes: Math.round(Number(row.avg_execution_time_minutes || 0) * 10) / 10,
      quality_score: quality,
      supervisor_rating: quality > 0 ? (quality >= 90 ? 4.9 : quality >= 80 ? 4.5 : 3.8) : 0,
    };
  }).sort((a, b) =>
    b.quality_score - a.quality_score ||
    b.compliance_rate - a.compliance_rate ||
    b.tasks_completed_on_time - a.tasks_completed_on_time
  );
  res.json({ data, meta: { startDate, endDate } });
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

app.get("/api/system/validation", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const countQueries = [
    ["users", "SELECT COUNT(*)::int AS count FROM users"],
    ["locations", "SELECT COUNT(*)::int AS count FROM locations"],
    ["zones", "SELECT COUNT(*)::int AS count FROM zones"],
    ["sop_items", "SELECT COUNT(*)::int AS count FROM sop_items"],
    ["task_templates", "SELECT COUNT(*)::int AS count FROM task_templates"],
    ["task_instances", "SELECT COUNT(*)::int AS count FROM task_instances"],
    ["task_media", "SELECT COUNT(*)::int AS count FROM task_media"],
    ["operational_tasks", "SELECT COUNT(*)::int AS count FROM operational_tasks"],
    ["device_switches", "SELECT COUNT(*)::int AS count FROM device_switches"],
    ["kpi_snapshots", "SELECT COUNT(*)::int AS count FROM kpi_snapshots"],
    ["audit_logs", "SELECT COUNT(*)::int AS count FROM audit_logs"],
    ["inventory_items", "SELECT COUNT(*)::int AS count FROM inventory_items"],
  ] as const;
  const details: Array<{
    collectionName: string; totalDocs: number; passedDocs: number;
    failedDocs: number; errors: string[]; warnings: string[];
  }> = [];
  let totalDocuments = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  for (const [collectionName, sql] of countQueries) {
    const result = await pool.query<{ count: number }>(sql);
    const count = Number(result.rows[0]?.count || 0);
    totalDocuments += count;
    details.push({
      collectionName, totalDocs: count, passedDocs: count,
      failedDocs: 0, errors: [], warnings: [],
    });
  }
  const sourceMappings = [
    ["users", "users"],
    ["locations", "locations"],
    ["zones", "zones"],
    ["sop_items", "sop_items"],
    ["task_templates", "task_templates"],
    ["task_instances", "task_instances"],
    ["operational_tasks", "operational_tasks"],
    ["device_switches", "device_switches"],
    ["kpi_snapshots", "kpi_snapshots"],
    ["audit_logs", "audit_logs"],
  ] as const;
  for (const [collectionName, tableName] of sourceMappings) {
    const parity = await pool.query<{ source_count: number; normalized_count: number }>(
      "SELECT " +
      "(SELECT COUNT(*)::int FROM firestore_documents WHERE collection_name = $1 " +
      "AND array_length(string_to_array(document_path, '/'), 1) = 2) AS source_count, " +
      "(SELECT COUNT(*)::int FROM " + tableName + ") AS normalized_count",
      [collectionName],
    );
    const sourceCount = Number(parity.rows[0]?.source_count || 0);
    const normalizedCount = Number(parity.rows[0]?.normalized_count || 0);
    const detail = details.find((item) => item.collectionName === collectionName);
    if (normalizedCount < sourceCount && detail) {
      const difference = sourceCount - normalizedCount;
      detail.errors.push("Top-level source archive contains " + sourceCount +
        " documents, but normalized PostgreSQL contains only " + normalizedCount + ".");
      detail.failedDocs += difference;
      detail.passedDocs = Math.max(0, detail.totalDocs - detail.failedDocs);
      totalErrors += 1;
    }
  }
  const checks = [
    ["zones", "SELECT COUNT(*)::int AS count FROM zones z LEFT JOIN locations l ON l.id = z.location_id WHERE z.location_id IS NOT NULL AND l.id IS NULL", "Zone records reference missing locations."],
    ["zones", "SELECT COUNT(*)::int AS count FROM zones z LEFT JOIN users u ON u.id = z.responsible_employee_id WHERE z.responsible_employee_id IS NOT NULL AND u.id IS NULL", "Zone records reference missing responsible employees."],
    ["sop_items", "SELECT COUNT(*)::int AS count FROM sop_items s LEFT JOIN zones z ON z.id = s.zone_id WHERE z.id IS NULL", "SOP records reference missing zones."],
    ["task_instances", "SELECT COUNT(*)::int AS count FROM task_instances t LEFT JOIN users u ON u.id = t.assigned_to WHERE u.id IS NULL", "Tasks reference missing assignees."],
    ["task_instances", "SELECT COUNT(*)::int AS count FROM task_instances t LEFT JOIN zones z ON z.id = t.zone_id WHERE z.id IS NULL", "Tasks reference missing zones."],
    ["operational_tasks", "SELECT COUNT(*)::int AS count FROM operational_tasks t LEFT JOIN zones z ON z.id = t.zone_id WHERE t.zone_id IS NOT NULL AND z.id IS NULL", "Operational tasks reference missing zones."],
    ["device_switches", "SELECT COUNT(*)::int AS count FROM device_switches d LEFT JOIN zones z ON z.id = d.zone_id WHERE d.zone_id IS NOT NULL AND z.id IS NULL", "Device switches reference missing zones."],
    ["kpi_snapshots", "SELECT COUNT(*)::int AS count FROM kpi_snapshots k LEFT JOIN users u ON u.id = k.profile_id WHERE k.profile_id IS NOT NULL AND u.id IS NULL", "KPI snapshots reference missing users."],
    ["task_templates", "SELECT COUNT(*)::int AS count FROM task_templates tt LEFT JOIN zones z ON z.id = tt.zone_id WHERE z.id IS NULL", "Task templates reference missing zones."],
    ["task_media", "SELECT COUNT(*)::int AS count FROM task_media m LEFT JOIN task_instances t ON t.id = m.task_id WHERE t.id IS NULL", "Task media references missing tasks."],
  ] as const;
  for (const [collectionName, sql, message] of checks) {
    const result = await pool.query<{ count: number }>(sql);
    const count = Number(result.rows[0]?.count || 0);
    const detail = details.find((item) => item.collectionName === collectionName);
    if (count > 0 && detail) {
      detail.errors.push(message + " Count: " + count);
      detail.failedDocs += count;
      detail.passedDocs = Math.max(0, detail.totalDocs - detail.failedDocs);
      totalErrors += 1;
    }
  }
  const legacy = await pool.query<{ sop_orphans: number; template_orphans: number; base64_photos: number }>(
    "SELECT " +
    "(SELECT COUNT(*)::int FROM task_instances t LEFT JOIN sop_items s ON s.id = t.sop_item_id WHERE t.sop_item_id IS NOT NULL AND s.id IS NULL) AS sop_orphans, " +
    "(SELECT COUNT(*)::int FROM task_instances t LEFT JOIN task_templates tt ON tt.id = t.template_id LEFT JOIN sop_items s ON s.id = t.template_id WHERE t.template_id IS NOT NULL AND tt.id IS NULL AND s.id IS NULL) AS template_orphans, " +
    "(SELECT COUNT(*)::int FROM task_instances t WHERE t.raw_data::text LIKE '%data:image/%') AS base64_photos",
  );
  const legacyRow = legacy.rows[0];
  const taskDetail = details.find((item) => item.collectionName === "task_instances");
  if (taskDetail) {
    const orphanCount = Number(legacyRow?.sop_orphans || 0) + Number(legacyRow?.template_orphans || 0);
    if (orphanCount > 0) {
      taskDetail.warnings.push("Historical SOP/template references without current master matches: " + orphanCount + ". Preserve legacy IDs; do not auto-map.");
      totalWarnings += 1;
    }
    if (Number(legacyRow?.base64_photos || 0) > 0) {
      taskDetail.warnings.push("Base64 photo fields still require server-side Cloudinary migration: " + Number(legacyRow.base64_photos));
      totalWarnings += 1;
    }
  }
  res.json({
    timestamp: new Date().toISOString(),
    isPassed: totalErrors === 0,
    summary: {
      totalCollectionsChecked: details.length,
      totalDocumentsChecked: totalDocuments,
      totalErrors,
      totalWarnings,
    },
    details,
  });
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

const taskTemplateEditableFields = new Set([
  "title", "description", "goal", "task_code", "category", "tools_required",
  "frequency", "recurrence_days", "scheduled_time", "scheduled_times",
  "zone_id", "default_assignee_id", "is_active",
  "requires_photo_before", "requires_photo_after", "requires_supervisor_approval",
  "requires_gps", "requires_signature", "is_reopenable", "auto_escalate_if_late",
  "estimated_duration_minutes", "reference_image_url", "guide_image_url",
]);

app.get("/api/task-templates", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM task_templates ORDER BY task_code, id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.post("/api/task-templates", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  for (const key of Object.keys(body)) {
    if (!taskTemplateEditableFields.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const taskCode = typeof body.task_code === "string" ? body.task_code.trim() : "";
  const zoneId = typeof body.zone_id === "string" ? body.zone_id : "";
  if (!title || title.length > 300 || !taskCode || taskCode.length > 80 || !zoneId) {
    res.status(400).json({ error: "title, task_code and zone_id are required" }); return;
  }
  if (body.recurrence_days !== undefined && !Array.isArray(body.recurrence_days)) {
    res.status(400).json({ error: "recurrence_days must be an array" }); return;
  }
  if (body.scheduled_times !== undefined && !Array.isArray(body.scheduled_times)) {
    res.status(400).json({ error: "scheduled_times must be an array" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [zoneId]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown task template zone" }); return;
    }
    const defaultAssignee = typeof body.default_assignee_id === "string" ? body.default_assignee_id : null;
    if (defaultAssignee) {
      const eligible = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [defaultAssignee],
      );
      if (eligible.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Default assignee must be an active cleaner" }); return;
      }
    }
    const now = new Date().toISOString();
    const id = "tpl_" + randomBytes(8).toString("hex");
    const template = {
      ...body, id, title, task_code: taskCode, zone_id: zoneId,
      recurrence_days: Array.isArray(body.recurrence_days) ? body.recurrence_days : [],
      scheduled_times: Array.isArray(body.scheduled_times) ? body.scheduled_times : [],
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
      created_at: now, updated_at: now,
    };
    await client.query(
      "INSERT INTO task_templates (id, zone_id, task_code, title, category, is_active, raw_data, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz,$9::timestamptz)",
      [id, zoneId, taskCode, title, typeof body.category === "string" ? body.category : null,
        template.is_active, JSON.stringify(template), now, now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "task_template_created", JSON.stringify({ task_template_id: id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "task_template_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.status(201).json({ data: template });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/task-templates/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  for (const key of Object.keys(body)) {
    if (!taskTemplateEditableFields.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "At least one task template field is required" }); return;
  }
  if (body.recurrence_days !== undefined && !Array.isArray(body.recurrence_days)) {
    res.status(400).json({ error: "recurrence_days must be an array" }); return;
  }
  if (body.scheduled_times !== undefined && !Array.isArray(body.scheduled_times)) {
    res.status(400).json({ error: "scheduled_times must be an array" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT id, raw_data FROM task_templates WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Task template not found" }); return;
    }
    const current = selected.rows[0].raw_data && typeof selected.rows[0].raw_data === "object"
      ? selected.rows[0].raw_data as Record<string, unknown> : {};
    const now = new Date().toISOString();
    const merged: Record<string, unknown> = { ...current, ...body, id: req.params.id, updated_at: now };
    if (typeof merged.title !== "string" || !merged.title.trim() ||
        typeof merged.task_code !== "string" || !merged.task_code.trim() ||
        typeof merged.zone_id !== "string" || !merged.zone_id) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Task template title, task_code and zone_id are required" }); return;
    }
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [merged.zone_id]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown task template zone" }); return;
    }
    if (typeof merged.default_assignee_id === "string" && merged.default_assignee_id) {
      const eligible = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [merged.default_assignee_id],
      );
      if (eligible.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Default assignee must be an active cleaner" }); return;
      }
    }
    await client.query(
      "UPDATE task_templates SET zone_id = $2, task_code = $3, title = $4, category = $5, is_active = $6, raw_data = $7::jsonb, updated_at = $8::timestamptz WHERE id = $1",
      [req.params.id, merged.zone_id, merged.task_code, merged.title, merged.category || null,
        merged.is_active !== false, JSON.stringify(merged), now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "task_template_updated", JSON.stringify({ task_template_id: req.params.id, changed_fields: Object.keys(body), actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "task_template_updated", created_at: now }), now],
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

app.delete("/api/task-templates/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query("DELETE FROM task_templates WHERE id = $1 RETURNING id", [req.params.id]);
    if (deleted.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Task template not found" }); return;
    }
    const now = new Date().toISOString();
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "task_template_deleted", JSON.stringify({ task_template_id: req.params.id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "task_template_deleted", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

const sopEditableFields = new Set([
  "title", "description", "goal", "task_code", "category", "tools_required",
  "frequency", "recurrence_days", "scheduled_time", "scheduled_times",
  "zone_id", "default_assignee_id", "is_active",
  "requires_photo_before", "requires_photo_after", "requires_supervisor_approval",
  "requires_gps", "requires_signature", "is_reopenable", "auto_escalate_if_late", "estimated_duration_minutes", "reference_image_url", "guide_image_url", "created_at", "updated_at",
]);

app.post("/api/sop-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  for (const key of Object.keys(body)) {
    if (!sopEditableFields.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const zoneId = typeof body.zone_id === "string" ? body.zone_id : "";
  const frequency = typeof body.frequency === "string" ? body.frequency : "";
  if (!title || !zoneId || !frequency) {
    res.status(400).json({ error: "title, zone_id and frequency are required" }); return;
  }
  if (body.recurrence_days !== undefined && !Array.isArray(body.recurrence_days)) {
    res.status(400).json({ error: "recurrence_days must be an array" }); return;
  }
  if (body.scheduled_times !== undefined && !Array.isArray(body.scheduled_times)) {
    res.status(400).json({ error: "scheduled_times must be an array" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [zoneId]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown SOP zone" }); return;
    }
    const defaultAssignee = typeof body.default_assignee_id === "string" ? body.default_assignee_id : null;
    if (defaultAssignee) {
      const eligible = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [defaultAssignee],
      );
      if (eligible.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "SOP default assignee must be an active cleaner" }); return;
      }
    }
    const now = new Date().toISOString();
    const id = "sop_" + randomBytes(8).toString("hex");
    const sop: Record<string, unknown> = {
      ...body, id, title, zone_id: zoneId, frequency,
      recurrence_days: Array.isArray(body.recurrence_days) ? body.recurrence_days : [],
      scheduled_times: Array.isArray(body.scheduled_times) ? body.scheduled_times : [],
      default_assignee_id: defaultAssignee,
      is_active: typeof body.is_active === "boolean" ? body.is_active : true,
      created_at: now, updated_at: now,
    };
    await client.query(
      "INSERT INTO sop_items (id, title, task_code, zone_id, frequency, recurrence_days, scheduled_time, " +
      "scheduled_times, default_assignee_id, is_active, raw_data, created_at, updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11::jsonb,$12::timestamptz,$13::timestamptz)",
      [id, title, sop.task_code || null, zoneId, frequency, JSON.stringify(sop.recurrence_days),
        sop.scheduled_time || null, JSON.stringify(sop.scheduled_times), defaultAssignee,
        sop.is_active, JSON.stringify(sop), now, now],
    );
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "sop_created", JSON.stringify({ sop_id: id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "sop_created", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.status(201).json({ data: sop });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/sop-items/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  for (const key of Object.keys(body)) {
    if (!sopEditableFields.has(key)) {
      res.status(400).json({ error: "Field is not allowed: " + key }); return;
    }
  }
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "At least one SOP field must be provided" }); return;
  }
  if (body.recurrence_days !== undefined && !Array.isArray(body.recurrence_days)) {
    res.status(400).json({ error: "recurrence_days must be an array" }); return;
  }
  if (body.scheduled_times !== undefined && !Array.isArray(body.scheduled_times)) {
    res.status(400).json({ error: "scheduled_times must be an array" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT id, raw_data FROM sop_items WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (selected.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "SOP item not found" }); return;
    }
    const current = selected.rows[0].raw_data && typeof selected.rows[0].raw_data === "object"
      ? selected.rows[0].raw_data as Record<string, unknown> : {};
    const merged: Record<string, unknown> = { ...current, ...body, id: req.params.id, updated_at: new Date().toISOString() };
    if (typeof merged.title !== "string" || !merged.title.trim() ||
        typeof merged.zone_id !== "string" || typeof merged.frequency !== "string") {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "SOP title, zone_id and frequency are required" }); return;
    }
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [merged.zone_id]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown SOP zone" }); return;
    }
    if (typeof merged.default_assignee_id === "string" && merged.default_assignee_id) {
      const eligible = await client.query(
        "SELECT id FROM users WHERE id = $1 AND role = 'cleaner' AND is_active = TRUE",
        [merged.default_assignee_id],
      );
      if (eligible.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "SOP default assignee must be an active cleaner" }); return;
      }
    }
    await client.query(
      "UPDATE sop_items SET title = $2, task_code = $3, zone_id = $4, frequency = $5, " +
      "recurrence_days = $6::jsonb, scheduled_time = $7, scheduled_times = $8::jsonb, " +
      "default_assignee_id = $9, is_active = $10, raw_data = $11::jsonb, updated_at = $12::timestamptz " +
      "WHERE id = $1",
      [req.params.id, merged.title, merged.task_code || null, merged.zone_id, merged.frequency,
        JSON.stringify(Array.isArray(merged.recurrence_days) ? merged.recurrence_days : []),
        merged.scheduled_time || null, JSON.stringify(Array.isArray(merged.scheduled_times) ? merged.scheduled_times : []),
        merged.default_assignee_id || null, merged.is_active !== false, JSON.stringify(merged), merged.updated_at],
    );

    const today = getBusinessDate();
    const pending = await client.query(
      "SELECT id, raw_data, assigned_to, zone_id, due_date, due_time FROM task_instances " +
      "WHERE (sop_item_id = $1 OR template_id = $1) AND due_date >= $2::date AND status = 'pending' FOR UPDATE",
      [req.params.id, today],
    );
    for (const row of pending.rows) {
      const task = {
        ...(row.raw_data && typeof row.raw_data === "object" ? row.raw_data : {}),
        title: merged.title,
        description: merged.description || "",
        goal: merged.goal || "",
        task_code: merged.task_code || "",
        category: merged.category || "تشغيل",
        tools_required: merged.tools_required || "",
        estimated_duration_minutes: merged.estimated_duration_minutes || 0,
        zone_id: merged.zone_id,
        guide_image_url: merged.guide_image_url || "",
        reference_image_url: merged.reference_image_url || "",
        requires_photo_before: merged.requires_photo_before ?? true,
        requires_photo_after: merged.requires_photo_after ?? true,
        requires_supervisor_approval: merged.requires_supervisor_approval ?? true,
        requires_gps: merged.requires_gps ?? false,
        requires_signature: false,
        assigned_to: merged.default_assignee_id || row.assigned_to,
        due_time: row.due_time || "09:00",
        updated_at: merged.updated_at,
      };
      await client.query(
        "UPDATE task_instances SET title = $2, description = $3, zone_id = $4, assigned_to = $5, " +
        "due_time = $6, raw_data = $7::jsonb, updated_at = $8::timestamptz WHERE id = $1",
        [row.id, task.title, task.description, task.zone_id, task.assigned_to,
          task.due_time, JSON.stringify(task), task.updated_at],
      );
    }
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "sop_updated", JSON.stringify({ sop_id: req.params.id, changed_fields: Object.keys(body), future_tasks_updated: pending.rowCount, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "sop_updated", created_at: merged.updated_at }), merged.updated_at],
    );
    await client.query("COMMIT");
    res.json({ data: merged, meta: { future_pending_tasks_updated: pending.rowCount } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.delete("/api/sop-items/:id", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query("DELETE FROM sop_items WHERE id = $1 RETURNING id", [req.params.id]);
    if (deleted.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "SOP item not found" }); return;
    }
    const now = new Date().toISOString();
    const auditId = "audit_" + randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO audit_logs (id, action, metadata, raw_data, created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz)",
      [auditId, "sop_deleted", JSON.stringify({ sop_id: req.params.id, actor_id: req.auth?.id }),
        JSON.stringify({ id: auditId, action: "sop_deleted", created_at: now }), now],
    );
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/sop-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM sop_items ORDER BY id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.post("/api/media/delete", requireAuth, asyncRoute(async (req, res) => {
  const publicId = typeof req.body?.public_id === "string" ? req.body.public_id.trim() : "";
  const taskId = typeof req.body?.task_id === "string" ? req.body.task_id.trim() : "";
  if (!publicId || publicId.length > 500 || !taskId || taskId.length > 200) {
    res.status(400).json({ error: "public_id and task_id are required" }); return;
  }
  const taskResult = await pool.query(
    "SELECT assigned_to, zone_id FROM task_instances WHERE id = $1",
    [taskId],
  );
  if (taskResult.rowCount !== 1) {
    res.status(404).json({ error: "Task not found" }); return;
  }
  const task = taskResult.rows[0];
  if (req.auth?.role === "cleaner" && task.assigned_to !== req.auth.id) {
    res.status(403).json({ error: "You can only clean up media for your assigned tasks" }); return;
  }
  if (req.auth?.role !== "cleaner" && req.auth?.role !== "admin" && req.auth?.role !== "supervisor") {
    res.status(403).json({ error: "Not authorized to delete media" }); return;
  }
  const expectedPrefix = "task-photos/" + String(task.zone_id) + "/" + taskId + "/";
  if (!publicId.startsWith(expectedPrefix)) {
    res.status(400).json({ error: "Cloudinary public_id does not belong to this task" }); return;
  }
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME || "";
  const apiKey = process.env.CLOUDINARY_API_KEY || "";
  const apiSecret = process.env.CLOUDINARY_API_SECRET || "";
  if (!cloudName || !apiKey || !apiSecret) {
    res.status(503).json({ error: "Cloudinary server-side deletion is not configured" }); return;
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHash("sha1")
    .update("public_id=" + publicId + "&timestamp=" + timestamp + apiSecret, "utf8")
    .digest("hex");
  const form = new URLSearchParams({
    public_id: publicId,
    timestamp,
    api_key: apiKey,
    signature,
  });
  const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(cloudName) + "/image/destroy", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const payload = await response.json().catch(() => ({})) as { result?: string; error?: { message?: string } };
  if (!response.ok || (payload.result !== "ok" && payload.result !== "not found")) {
    res.status(502).json({ error: payload.error?.message || "Cloudinary media deletion failed" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      "SELECT raw_data FROM task_instances WHERE id = $1 FOR UPDATE",
      [taskId],
    );
    if (selected.rowCount === 1) {
      const raw = selected.rows[0].raw_data && typeof selected.rows[0].raw_data === "object"
        ? { ...selected.rows[0].raw_data as Record<string, unknown> } : {};
      for (const side of ["before", "after"] as const) {
        const prefix = side === "before" ? "photo_before" : "photo_after";
        if (raw[prefix + "_public_id"] === publicId) {
          for (const suffix of ["_url", "_public_id", "_taken_at", "_uploaded_at", "_size", "_mime_type"]) {
            delete raw[prefix + suffix];
          }
          const photos = raw.photos && typeof raw.photos === "object"
            ? { ...raw.photos as Record<string, unknown> } : null;
          if (photos) {
            delete photos[side];
            delete photos[side + "_url"];
            raw.photos = photos;
          }
        }
      }
      await client.query(
        "UPDATE task_instances SET raw_data = $2::jsonb, updated_at = NOW() WHERE id = $1",
        [taskId, JSON.stringify(raw)],
      );
    }
    await client.query("DELETE FROM task_media WHERE task_id = $1 AND public_id = $2", [taskId, publicId]);
    const auditId = "audit_" + randomBytes(12).toString("hex");
    const now = new Date().toISOString();
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
      "VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)",
      [auditId, taskId, "task_media_deleted",
        JSON.stringify({ actor_id: req.auth?.id, public_id: publicId }),
        JSON.stringify({ id: auditId, task_id: taskId, action: "task_media_deleted", created_at: now }), now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  res.json({ success: true, result: payload.result });
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
  if (body.estimated_duration_minutes !== undefined &&
      (!Number.isFinite(Number(body.estimated_duration_minutes)) || Number(body.estimated_duration_minutes) < 0)) {
    res.status(400).json({ error: "estimated_duration_minutes must be a non-negative number" }); return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const zone = await client.query("SELECT id FROM zones WHERE id = $1", [zoneId]);
    if (zone.rowCount !== 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown task zone" }); return;
    }
    if (typeof body.template_id === "string" && body.template_id) {
      const template = await client.query(
        "SELECT id, zone_id FROM task_templates WHERE id = $1",
        [body.template_id],
      );
      if (template.rowCount !== 1 || String(template.rows[0].zone_id) !== zoneId) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Task template does not exist or belongs to another zone" }); return;
      }
    }
    if (typeof body.sop_item_id === "string" && body.sop_item_id) {
      const sop = await client.query(
        "SELECT id, zone_id FROM sop_items WHERE id = $1",
        [body.sop_item_id],
      );
      if (sop.rowCount !== 1 || String(sop.rows[0].zone_id) !== zoneId) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "SOP item does not exist or belongs to another zone" }); return;
      }
    }

    if (taskType === "rework") {
      const parent = await client.query("SELECT id FROM task_instances WHERE id = $1", [body.parent_instance_id]);
      if (parent.rowCount !== 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Rework parent task does not exist" }); return;
      }
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
      due_date: dateOnly(row.due_date), due_time: row.due_time, status: row.status,
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
      due_date: dateOnly(row.due_date), due_time: row.due_time,
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
    "photo_before_public_id", "photo_after_public_id",
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

  for (const field of ["photo_before_public_id", "photo_after_public_id"]) {
    const value = updates[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 500)) {
      res.status(400).json({ error: field + " must be a string up to 500 characters" }); return;
    }
  }
  for (const field of ["photo_before_url", "photo_after_url"]) {
    const value = updates[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 2_000_000 ||
        !(value.startsWith("https://") || value.startsWith("data:image/")))) {
      res.status(400).json({ error: field + " must be a valid HTTPS or legacy image data URL" }); return;
    }
  }
  for (const field of ["photo_before_size", "photo_after_size"]) {
    const value = updates[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 15 * 1024 * 1024)) {
      res.status(400).json({ error: field + " must be a non-negative image size up to 15 MB" }); return;
    }
  }
  for (const field of ["photo_before_mime_type", "photo_after_mime_type"]) {
    const value = updates[field];
    if (value !== undefined && (typeof value !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(value))) {
      res.status(400).json({ error: field + " is not a supported image MIME type" }); return;
    }
  }
  if (updates.photo_capture_status !== undefined &&
      !["pending", "uploading", "uploaded", "failed"].includes(String(updates.photo_capture_status))) {
    res.status(400).json({ error: "Unsupported photo_capture_status" }); return;
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
      due_date: dateOnly(row.due_date),
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
    let merged: TaskRecord;
    try {
      merged = applyTaskUpdate(current, updates as Partial<TaskRecord>, now);
    } catch (error) {
      await client.query("ROLLBACK");
      res.status(422).json({
        error: error instanceof Error ? error.message : "Task update validation failed",
      });
      return;
    }
    const result = await client.query(
      "UPDATE task_instances SET assigned_to = $2, zone_id = $3, due_date = $4::date, " +
      "due_time = $5, status = $6, title = $7, description = $8, " +
      "raw_data = $9::jsonb, updated_at = $10::timestamptz WHERE id = $1 RETURNING id",
      [req.params.id, merged.assigned_to, merged.zone_id, merged.due_date,
        merged.due_time, merged.status, merged.title, merged.description, JSON.stringify(merged), now],
    );
    if (result.rowCount !== 1) throw new Error("Task update did not affect exactly one row");

    const changedFields = Object.keys(updates);
    if (changedFields.some((field) => field.startsWith("photo_before_"))) {
      await upsertTaskMediaRecord(client, req.params.id, merged, "before");
    }
    if (changedFields.some((field) => field.startsWith("photo_after_"))) {
      await upsertTaskMediaRecord(client, req.params.id, merged, "after");
    }
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
      due_date: dateOnly(row.due_date), due_time: row.due_time, status: row.status,
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

function businessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

async function ensureDailyTasks(date: string): Promise<void> {
  const completed = await pool.query(
    "SELECT 1 FROM task_generation_runs WHERE run_date = $1::date AND status = 'completed' LIMIT 1",
    [date],
  );
  if (completed.rowCount) return;
  const summary = await generateRecurringTasksForDate(pool, date);
  process.stdout.write("[Task generator] " + JSON.stringify(summary) + "\\n");
}

async function start(): Promise<void> {
  assertNarisDatabaseUrl(process.env.DATABASE_URL);
  await pool.query("SELECT 1");
  const server = app.listen(PORT, "0.0.0.0", () => {
    process.stdout.write("Naris Ops API listening on port " + PORT + "\n");
  });
  let scheduler: ReturnType<typeof setInterval> | undefined;
  if (process.env.TASK_GENERATION_ENABLED === "true") {
    let schedulerRunning = false;
    const runScheduler = async () => {
      if (schedulerRunning) return;
      schedulerRunning = true;
      try {
        await ensureDailyTasks(businessDate());
      } catch (error) {
        console.error("[Task generator] Daily generation attempt failed:", error instanceof Error ? error.message : "unknown error");
      } finally {
        schedulerRunning = false;
      }
    };
    void runScheduler();
    scheduler = setInterval(() => void runScheduler(), 60_000);
  } else {
    process.stdout.write("Daily task generation is disabled; enable it after data import.\\n");
  }
  const shutdown = (signal: string) => {
    if (scheduler) clearInterval(scheduler);
    process.stdout.write(signal + " received; shutting down API.\n");
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
export { app, pool };

if (process.env.NODE_ENV !== "test") {
  start().catch((error: unknown) => {
    console.error("API startup failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
