import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

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
  const sameSite = secure ? "None" : "Lax";
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=" + encodeURIComponent(token) +
    "; HttpOnly; Path=/; SameSite=" + sameSite +
    (secure ? "; Secure" : "") + "; Max-Age=" + String(SESSION_HOURS * 3600));
}
function clearSessionCookie(res: Response): void {
  res.setHeader("Set-Cookie",
    COOKIE_NAME + "=; HttpOnly; Path=/; SameSite=" +
    (process.env.NODE_ENV === "production" ? "None; Secure" : "Lax") +
    "; Max-Age=0");
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
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
}
function asyncRoute(
  handler: (req: AuthRequest, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req as AuthRequest, res).catch(next);
  };
}

app.disable("x-powered-by");
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
  await pool.query("SELECT 1");
  res.json({ status: "ready", database: "connected" });
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

app.get("/api/sop-items", requireAuth, allowRoles("admin", "supervisor"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id, raw_data FROM sop_items ORDER BY id");
  res.json({ data: result.rows.map((row) => ({ ...row.raw_data, id: row.id })) });
}));

app.get("/api/tasks", requireAuth, asyncRoute(async (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : null;
  const start = typeof req.query.startDate === "string" ? req.query.startDate : null;
  const end = typeof req.query.endDate === "string" ? req.query.endDate : null;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date must use YYYY-MM-DD" }); return;
  }
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start) || end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    res.status(400).json({ error: "Date range must use YYYY-MM-DD" }); return;
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
  const result = await pool.query(
    "SELECT id, raw_data, assigned_to, due_date, due_time, status FROM task_instances" +
    where + " ORDER BY due_date, due_time NULLS LAST, id",
    values,
  );
  res.json({ data: result.rows.map((row) => ({
    ...row.raw_data, id: row.id, assigned_to: row.assigned_to,
    due_date: String(row.due_date).slice(0, 10), due_time: row.due_time, status: row.status,
  })) });
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  // Never return SQL, credentials, stack traces, or database details to clients.
  console.error("[API]", message);
  res.status(500).json({ error: "Internal server error" });
});

async function start(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await pool.query("SELECT 1");
  app.listen(PORT, "0.0.0.0", () => {
    process.stdout.write("Naris Ops API listening on port " + PORT + "\n");
  });
}
start().catch((error: unknown) => {
  console.error("API startup failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
