import "dotenv/config";
import { Pool } from "pg";
import { assertNarisDatabaseUrl } from "./db/connection";

type JsonRecord = Record<string, unknown>;
type CloudinaryResult = { secure_url: string; public_id: string; bytes?: number; format?: string };

const BEFORE_KEYS = ["photo_before_url", "before_photo_url", "before_photo", "photoBefore"] as const;
const AFTER_KEYS = ["photo_after_url", "after_photo_url", "after_photo", "photoAfter"] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function findDataUri(raw: JsonRecord, keys: readonly string[], nestedKeys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.startsWith("data:image/")) return value;
  }
  const photos = isRecord(raw.photos) ? raw.photos : {};
  for (const key of nestedKeys) {
    const value = photos[key];
    if (typeof value === "string" && value.startsWith("data:image/")) return value;
  }
  return null;
}
function replaceDataUris(raw: JsonRecord, keys: readonly string[], nestedKeys: readonly string[], url: string): void {
  for (const key of keys) {
    if (typeof raw[key] === "string" && String(raw[key]).startsWith("data:image/")) raw[key] = url;
  }
  const photos = isRecord(raw.photos) ? { ...raw.photos } : {};
  for (const key of nestedKeys) {
    if (typeof photos[key] === "string" && String(photos[key]).startsWith("data:image/")) photos[key] = url;
  }
  if (Object.keys(photos).length > 0) raw.photos = photos;
}
async function uploadDataUri(dataUri: string, folder: string): Promise<CloudinaryResult> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME || "";
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET || process.env.VITE_CLOUDINARY_UPLOAD_PRESET || "";
  if (!cloudName || !preset) {
    throw new Error("Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET (or their VITE_ equivalents) before --apply.");
  }
  const form = new FormData();
  form.append("file", dataUri);
  form.append("upload_preset", preset);
  form.append("folder", folder);
  form.append("tags", "naris-ops,legacy-firestore-media-migration");
  const response = await fetch("https://api.cloudinary.com/v1_1/" + encodeURIComponent(cloudName) + "/image/upload", {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => ({})) as Partial<CloudinaryResult> & { error?: { message?: string } };
  if (!response.ok || !payload.secure_url || !payload.public_id) {
    throw new Error(payload.error?.message || "Cloudinary upload failed with HTTP " + response.status);
  }
  return payload as CloudinaryResult;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 0;
  if (limitArg >= 0 && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  const pool = new Pool({ connectionString: assertNarisDatabaseUrl(process.env.DATABASE_URL) });
  let tasksScanned = 0;
  let beforeUploaded = 0;
  let afterUploaded = 0;
  let failures = 0;
  try {
    const result = await pool.query<{ id: string; zone_id: string; raw_data: JsonRecord }>(
      "SELECT id, zone_id, raw_data FROM task_instances " +
      "WHERE raw_data::text LIKE '%data:image/%' ORDER BY due_date, id" +
      (limit ? " LIMIT " + String(limit) : ""),
    );
    for (const row of result.rows) {
      tasksScanned += 1;
      const raw = isRecord(row.raw_data) ? { ...row.raw_data } : {};
      const before = findDataUri(raw, BEFORE_KEYS, ["before", "before_url"]);
      const after = findDataUri(raw, AFTER_KEYS, ["after", "after_url"]);
      if (!before && !after) continue;
      if (!apply) {
        process.stdout.write(JSON.stringify({ mode: "dry-run", task_id: row.id, before: Boolean(before), after: Boolean(after) }) + "\n");
        continue;
      }
      for (const side of ["before", "after"] as const) {
        const source = side === "before" ? before : after;
        if (!source) continue;
        try {
          const uploaded = await uploadDataUri(
            source,
            "task-photos/" + String(row.zone_id) + "/" + row.id,
          );
          const keys = side === "before" ? BEFORE_KEYS : AFTER_KEYS;
          const nested = side === "before" ? ["before", "before_url"] as const : ["after", "after_url"] as const;
          replaceDataUris(raw, keys, nested, uploaded.secure_url);
          raw[side === "before" ? "photo_before_url" : "photo_after_url"] = uploaded.secure_url;
          raw[side === "before" ? "photo_before_public_id" : "photo_after_public_id"] = uploaded.public_id;
          raw[side === "before" ? "photo_before_size" : "photo_after_size"] = uploaded.bytes || 0;
          raw[side === "before" ? "photo_before_mime_type" : "photo_after_mime_type"] = "image/" + (uploaded.format || "jpeg");
          raw.photo_capture_status = "uploaded";
          await pool.query(
            "UPDATE task_instances SET raw_data = $2::jsonb, updated_at = NOW() WHERE id = $1",
            [row.id, JSON.stringify(raw)],
          );
          if (side === "before") beforeUploaded += 1;
          else afterUploaded += 1;
        } catch (error) {
          failures += 1;
          process.stderr.write(JSON.stringify({
            task_id: row.id,
            side,
            error: error instanceof Error ? error.message : "Unknown upload error",
          }) + "\n");
          break;
        }
      }
    }
    process.stdout.write(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      tasks_scanned: tasksScanned,
      before_uploaded: beforeUploaded,
      after_uploaded: afterUploaded,
      failures,
      remaining_base64_tasks: apply ? "Run the command again to verify; any remaining data URIs will be listed." : "Not changed in dry-run.",
    }, null, 2) + "\n");
    if (failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write("Cloudinary media migration failed: " +
    (error instanceof Error ? error.message : "Unknown error") + "\n");
  process.exitCode = 1;
});
