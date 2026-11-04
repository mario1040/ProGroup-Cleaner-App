import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { assertNarisDatabaseUrl } from "./db/connection";

interface FirestoreDocument {
  name: string;
  fields?: Record<string, unknown>;
  createTime?: string;
  updateTime?: string;
}
interface FirestorePage { documents?: FirestoreDocument[]; nextPageToken?: string; }
interface CollectionSummary { pages: number; documents: number; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeFirestoreValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value && isRecord(value.arrayValue)) {
    const values = value.arrayValue.values;
    return Array.isArray(values) ? values.map(decodeFirestoreValue) : [];
  }
  if ("mapValue" in value && isRecord(value.mapValue)) {
    return decodeFirestoreFields(value.mapValue.fields);
  }
  return value;
}

function decodeFirestoreFields(fields: unknown): Record<string, unknown> {
  if (!isRecord(fields)) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]),
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function asDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function asDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}
function getDocumentPath(document: FirestoreDocument): string {
  const marker = "/documents/";
  const index = document.name.indexOf(marker);
  if (index < 0) throw new Error("A Firestore document has an invalid resource name.");
  return document.name.slice(index + marker.length);
}
function sanitizeCollectionData(
  collectionName: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (collectionName !== "users") return data;
  const { password: _passwordRecord, ...safeData } = data;
  return safeData;
}
function validateUserPasswordRecord(value: unknown): "salted_sha256" | "legacy_plaintext" | "missing" {
  if (typeof value !== "string" || value.length === 0) return "missing";
  return /^[a-f0-9]{16,}:[a-f0-9]{64}$/i.test(value)
    ? "salted_sha256"
    : "legacy_plaintext";
}

function validateNormalizedDocument(
  collectionName: string,
  data: Record<string, unknown>,
): void {
  if (collectionName === "users") {
    const role = asString(data.role);
    if (!asString(data.username) || !asString(data.full_name) || !role) {
      throw new Error("A user record is missing required account fields.");
    }
    if (!["admin", "supervisor", "cleaner"].includes(role)) {
      throw new Error("A user record contains an unsupported role value.");
    }
  } else if (collectionName === "locations" && !asString(data.name)) {
    throw new Error("A location record is missing its name.");
  } else if (collectionName === "zones" && !asString(data.name)) {
    throw new Error("A zone record is missing its name.");
  } else if (collectionName === "sop_items") {
    if (!asString(data.title) || !asString(data.zone_id) || !asString(data.frequency)) {
      throw new Error("An SOP record is missing required scheduling fields.");
    }
  } else if (collectionName === "task_instances") {
    if (
      !asString(data.zone_id) ||
      !asString(data.assigned_to) ||
      !asString(data.title) ||
      !asDateOnly(data.due_date)
    ) {
      throw new Error("A task instance is missing required task fields.");
    }
  } else if (collectionName === "operational_tasks") {
    if (!asString(data.title) || !asString(data.zone_id)) {
      throw new Error("An operational task is missing required title or zone fields.");
    }
  } else if (collectionName === "device_switches") {
    if (!asString(data.code) || !asString(data.label)) {
      throw new Error("A device switch is missing its code or label.");
    }
  } else if (collectionName === "audit_logs" && !asString(data.action)) {
    throw new Error("An audit log record is missing its action.");
  }
  }
}

async function insertGenericDocument(
  client: PoolClient,
  collectionName: string,
  documentPath: string,
  documentId: string,
  data: Record<string, unknown>,
  document: FirestoreDocument,
): Promise<void> {
  const safeData = sanitizeCollectionData(collectionName, data);
  await client.query(
    "INSERT INTO firestore_documents " +
      "(collection_name, document_path, document_id, data, source_create_time, source_update_time) " +
      "VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz) " +
      "ON CONFLICT (collection_name, document_path) DO UPDATE SET " +
      "document_id = EXCLUDED.document_id, data = EXCLUDED.data, " +
      "source_create_time = EXCLUDED.source_create_time, " +
      "source_update_time = EXCLUDED.source_update_time, imported_at = NOW()",
    [
      collectionName, documentPath, documentId, JSON.stringify(safeData),
      asDate(document.createTime), asDate(document.updateTime),
    ],
  );
}

async function insertNormalizedDocument(
  client: PoolClient,
  collectionName: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const safeData = sanitizeCollectionData(collectionName, data);

  if (collectionName === "users") {
    await client.query(
      "INSERT INTO users " +
        "(id, username, full_name, role, is_active, password_record, raw_data, created_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz) " +
        "ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, " +
        "full_name = EXCLUDED.full_name, role = EXCLUDED.role, " +
        "is_active = EXCLUDED.is_active, " +
        "password_record = COALESCE(EXCLUDED.password_record, users.password_record), " +
        "raw_data = EXCLUDED.raw_data, updated_at = EXCLUDED.updated_at",
      [
        id, asString(data.username), asString(data.full_name), asString(data.role),
        asBoolean(data.is_active), asString(data.password), JSON.stringify(safeData),
        asDate(data.created_at), asDate(data.updated_at),
      ],
    );
    return;
  }

  if (collectionName === "locations") {
    await client.query(
      "INSERT INTO locations (id, name, address, raw_data) VALUES ($1, $2, $3, $4::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, " +
        "address = EXCLUDED.address, raw_data = EXCLUDED.raw_data",
      [id, asString(data.name), asString(data.address), JSON.stringify(safeData)],
    );
    return;
  }

  if (collectionName === "zones") {
    await client.query(
      "INSERT INTO zones (id, location_id, name, responsible_employee_id, raw_data) " +
        "VALUES ($1, $2, $3, $4, $5::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET location_id = EXCLUDED.location_id, " +
        "name = EXCLUDED.name, responsible_employee_id = EXCLUDED.responsible_employee_id, " +
        "raw_data = EXCLUDED.raw_data",
      [
        id, asString(data.location_id), asString(data.name),
        asString(data.responsible_employee_id), JSON.stringify(safeData),
      ],
    );
    return;
  }

  if (collectionName === "sop_items") {
    await client.query(
      "INSERT INTO sop_items " +
        "(id, title, task_code, zone_id, frequency, recurrence_days, scheduled_time, " +
        "scheduled_times, default_assignee_id, is_active, raw_data, created_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11::jsonb, $12::timestamptz, $13::timestamptz) " +
        "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, task_code = EXCLUDED.task_code, " +
        "zone_id = EXCLUDED.zone_id, frequency = EXCLUDED.frequency, " +
        "recurrence_days = EXCLUDED.recurrence_days, scheduled_time = EXCLUDED.scheduled_time, " +
        "scheduled_times = EXCLUDED.scheduled_times, default_assignee_id = EXCLUDED.default_assignee_id, " +
        "is_active = EXCLUDED.is_active, raw_data = EXCLUDED.raw_data, " +
        "created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at",
      [
        id, asString(data.title), asString(data.task_code), asString(data.zone_id),
        asString(data.frequency), JSON.stringify(asStringArray(data.recurrence_days)),
        asString(data.scheduled_time), JSON.stringify(asStringArray(data.scheduled_times)),
        asString(data.default_assignee_id), asBoolean(data.is_active),
        JSON.stringify(safeData), asDate(data.created_at), asDate(data.updated_at),
      ],
    );
    return;
  }

  if (collectionName === "task_instances") {
    await client.query(
      "INSERT INTO task_instances " +
        "(id, template_id, sop_item_id, zone_id, assigned_to, assigned_by, task_type, " +
        "parent_instance_id, title, description, due_date, due_time, status, raw_data, created_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, $14::jsonb, $15::timestamptz, $16::timestamptz) " +
        "ON CONFLICT (id) DO UPDATE SET template_id = EXCLUDED.template_id, " +
        "sop_item_id = EXCLUDED.sop_item_id, zone_id = EXCLUDED.zone_id, " +
        "assigned_to = EXCLUDED.assigned_to, assigned_by = EXCLUDED.assigned_by, " +
        "task_type = EXCLUDED.task_type, parent_instance_id = EXCLUDED.parent_instance_id, " +
        "title = EXCLUDED.title, description = EXCLUDED.description, due_date = EXCLUDED.due_date, " +
        "due_time = EXCLUDED.due_time, status = EXCLUDED.status, raw_data = EXCLUDED.raw_data, " +
        "created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at",
      [
        id, asString(data.template_id), asString(data.sop_item_id), asString(data.zone_id),
        asString(data.assigned_to), asString(data.assigned_by),
        asString(data.task_type) || "one_time", asString(data.parent_instance_id),
        asString(data.title), asString(data.description), asDateOnly(data.due_date),
        asString(data.due_time), asString(data.status) || "pending",
        JSON.stringify(safeData), asDate(data.created_at), asDate(data.updated_at),
      ],
    );
    return;
  }

  if (collectionName === "operational_tasks") {
    await client.query(
      "INSERT INTO operational_tasks (id, zone_id, title, description, responsible_employee_id, is_active, raw_data) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET zone_id = EXCLUDED.zone_id, title = EXCLUDED.title, " +
        "description = EXCLUDED.description, responsible_employee_id = EXCLUDED.responsible_employee_id, " +
        "is_active = EXCLUDED.is_active, raw_data = EXCLUDED.raw_data",
      [id, asString(data.zone_id), asString(data.title) || "", asString(data.description),
        asString(data.responsible_employee_id), asBoolean(data.is_active, true), JSON.stringify(safeData)],
    );
    return;
  }

  if (collectionName === "device_switches") {
    await client.query(
      "INSERT INTO device_switches (id, code, label, zone_id, panel_location, raw_data) " +
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, label = EXCLUDED.label, " +
        "zone_id = EXCLUDED.zone_id, panel_location = EXCLUDED.panel_location, raw_data = EXCLUDED.raw_data",
      [id, asString(data.code) || "", asString(data.label) || "", asString(data.zone_id),
        asString(data.panel_location), JSON.stringify(safeData)],
    );
    return;
  }

  if (collectionName === "kpi_snapshots") {
    await client.query(
      "INSERT INTO kpi_snapshots (id, profile_id, period_type, period_start, period_end, tasks_assigned, " +
        "tasks_completed_on_time, tasks_late, tasks_reworked, compliance_rate, avg_execution_time_minutes, " +
        "quality_score, supervisor_rating, raw_data, computed_at) " +
        "VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::timestamptz) " +
        "ON CONFLICT (id) DO UPDATE SET profile_id = EXCLUDED.profile_id, period_type = EXCLUDED.period_type, " +
        "period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, tasks_assigned = EXCLUDED.tasks_assigned, " +
        "tasks_completed_on_time = EXCLUDED.tasks_completed_on_time, tasks_late = EXCLUDED.tasks_late, " +
        "tasks_reworked = EXCLUDED.tasks_reworked, compliance_rate = EXCLUDED.compliance_rate, " +
        "avg_execution_time_minutes = EXCLUDED.avg_execution_time_minutes, quality_score = EXCLUDED.quality_score, " +
        "supervisor_rating = EXCLUDED.supervisor_rating, raw_data = EXCLUDED.raw_data, computed_at = EXCLUDED.computed_at",
      [id, asString(data.profile_id), asString(data.period_type), asDateOnly(data.period_start),
        asDateOnly(data.period_end), asNumber(data.tasks_assigned), asNumber(data.tasks_completed_on_time),
        asNumber(data.tasks_late), asNumber(data.tasks_reworked), asNumber(data.compliance_rate),
        asNumber(data.avg_execution_time_minutes), asNumber(data.quality_score), asNumber(data.supervisor_rating),
        JSON.stringify(safeData), asDate(data.computed_at)],
    );
    return;
  }

  if (collectionName === "audit_logs") {
    await client.query(
      "INSERT INTO audit_logs (id, task_id, action, metadata, raw_data, created_at) " +
        "VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz) " +
        "ON CONFLICT (id) DO UPDATE SET task_id = EXCLUDED.task_id, action = EXCLUDED.action, " +
        "metadata = EXCLUDED.metadata, raw_data = EXCLUDED.raw_data, created_at = EXCLUDED.created_at",
      [id, asString(data.task_id), asString(data.action) || "unknown",
        JSON.stringify(isRecord(data.metadata) ? data.metadata : {}), JSON.stringify(safeData), asDate(data.created_at)],
    );
    return;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const backupArgIndex = args.indexOf("--backup-dir");
  const backupDir = backupArgIndex >= 0
    ? args[backupArgIndex + 1]
    : path.join(homedir(), "naris_ops_firestore_backup");

  if (!backupDir || backupDir.startsWith("--")) {
    throw new Error("Pass a valid directory after --backup-dir.");
  }

  const collectionEntries = await readdir(backupDir, { withFileTypes: true });
  const collections = collectionEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (collections.length === 0) {
    throw new Error("No collection folders were found in the backup directory.");
  }
  const connectionString = dryRun ? undefined : assertNarisDatabaseUrl(process.env.DATABASE_URL);
  const pool = dryRun ? null : new Pool({ connectionString });
  const summary = new Map<string, CollectionSummary>();
  const usernames = new Set<string>();
  let saltedPasswordRecords = 0;
  let legacyPasswordRecords = 0;
  let missingPasswordRecords = 0;
  let totalDocuments = 0;

  try {
    for (const collectionName of collections) {
      const collectionDir = path.join(backupDir, collectionName);
      const pageFiles = (await readdir(collectionDir))
        .filter((file) => /^page-\d+\.json$/.test(file))
        .sort();
      const collectionSummary = { pages: 0, documents: 0 };
      summary.set(collectionName, collectionSummary);

      for (const pageFile of pageFiles) {
        const pagePath = path.join(collectionDir, pageFile);
        const page = JSON.parse(await readFile(pagePath, "utf8")) as FirestorePage;
        const documents = Array.isArray(page.documents) ? page.documents : [];
        const client = pool ? await pool.connect() : null;

        try {
          if (client) await client.query("BEGIN");
          for (const document of documents) {
            const documentPath = getDocumentPath(document);
            const pathParts = documentPath.split("/");
            if (pathParts.length < 2 || pathParts.length % 2 !== 0) {
              throw new Error("A Firestore backup document path is malformed.");
            }
            const documentId = pathParts[pathParts.length - 1];
            const actualCollection = pathParts[pathParts.length - 2];
            const data = decodeFirestoreFields(document.fields);

            if (pathParts.length === 2) {
              validateNormalizedDocument(actualCollection, data);
            }

            if (actualCollection === "users") {
              const username = asString(data.username);
              if (username) {
                const normalizedUsername = username.trim().toLowerCase();
                if (usernames.has(normalizedUsername)) {
                  throw new Error("Duplicate usernames were found; resolve them before importing.");
                }
                usernames.add(normalizedUsername);
              }
              const passwordState = validateUserPasswordRecord(data.password);
              if (passwordState === "salted_sha256") saltedPasswordRecords += 1;
              else if (passwordState === "legacy_plaintext") {
                legacyPasswordRecords += 1;
                if (!dryRun) {
                  throw new Error(
                    "Legacy plaintext password records were detected. Rotate those passwords before importing.",
                  );
                }
              } else missingPasswordRecords += 1;
            }

            if (client) {
              await insertGenericDocument(
                client, actualCollection, documentPath, documentId, data, document,
              );
              if (pathParts.length === 2) {
                await insertNormalizedDocument(client, actualCollection, documentId, data);
              }
            }
            collectionSummary.documents += 1;
            totalDocuments += 1;
          }
          if (client) await client.query("COMMIT");
          collectionSummary.pages += 1;
        } catch (error) {
          if (client) await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client?.release();
        }
      }
    }
  } finally {
    if (pool) await pool.end();
  }

  process.stdout.write(JSON.stringify({
    mode: dryRun ? "dry-run" : "import",
    totalDocuments,
    collections: Object.fromEntries(summary),
    passwordRecordAudit: {
      saltedSha256: saltedPasswordRecords,
      legacyPlaintext: legacyPasswordRecords,
      missing: missingPasswordRecords,
    },
  }, null, 2) + "\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    "Firestore import failed: " +
      (error instanceof Error ? error.message : "Unknown error") +
      "\n",
  );
  process.exitCode = 1;
});
