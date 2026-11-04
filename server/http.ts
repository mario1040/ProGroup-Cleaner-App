import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./db/connection";

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
