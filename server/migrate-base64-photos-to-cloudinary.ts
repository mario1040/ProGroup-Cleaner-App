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
function isImageSource(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("data:image/") || value.startsWith("https://"));
}
function findImageSource(raw: JsonRecord, keys: readonly string[], nestedKeys: readonly string[]): string | null {
  const candidates: string[] = [];
  for (const key of keys) if (isImageSource(raw[key])) candidates.push(raw[key] as string);
  const photos = isRecord(raw.photos) ? raw.photos : {};
  for (const key of nestedKeys) if (isImageSource(photos[key])) candidates.push(photos[key] as string);
  const unique = [...new Set(candidates)];
  if (unique.length > 1) {
    throw new Error("Multiple distinct image sources exist for one photo side; manual reconciliation is required.");
  }
  return unique[0] || null;
}
function replaceImageSource(
  raw: JsonRecord,
  keys: readonly string[],
  nestedKeys: readonly string[],
  oldSource: string,
  newUrl: string,
): void {
  for (const key of keys) if (raw[key] === oldSource) raw[key] = newUrl;
  const photos = isRecord(raw.photos) ? { ...raw.photos } : {};
  for (const key of nestedKeys) if (photos[key] === oldSource) photos[key] = newUrl;
  if (Object.keys(photos).length > 0) raw.photos = photos;
}
async function uploadImageSource(source: string, folder: string): Promise<CloudinaryResult> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME || "";
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET || process.env.VITE_CLOUDINARY_UPLOAD_PRESET || "";
  if (!cloudName || !preset) {
    throw new Error("Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET (or their VITE_ equivalents) before --apply.");
  }
  const form = new FormData();
  form.append("file", source);
  form.append("upload_preset", preset);
  form.append("folder", folder);
  form.append("tags", "naris-ops,legacy-media-migration");
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
function sourceKind(source: string): "base64" | "cloudinary" | "external_url" {
  if (source.startsWith("data:image/")) return "base64";
  return source.includes("res.cloudinary.com") ? "cloudinary" : "external_url";
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
  let mediaMigrated = 0;
  let mediaIndexed = 0;
  let failures = 0;
  try {
    const result = await pool.query<{ id: string; zone_id: string; raw_data: JsonRecord }>(
      "SELECT id, zone_id, raw_data FROM task_instances " +
      "WHERE raw_data::text LIKE '%data:image/%' OR raw_data::text LIKE '%https://%' " +
      "ORDER BY due_date, id" + (limit ? " LIMIT " + String(limit) : ""),
    );
    for (const row of result.rows) {
      tasksScanned += 1;
      const raw = isRecord(row.raw_data) ? { ...row.raw_data } : {};
      for (const side of ["before", "after"] as const) {
        const keys = side === "before" ? BEFORE_KEYS : AFTER_KEYS;
        const nested = side === "before" ? ["before", "before_url"] as const : ["after", "after_url"] as const;
        const prefix = side === "before" ? "photo_before" : "photo_after";
        let source: string | null;
        try {
          source = findImageSource(raw, keys, nested);
        } catch (error) {
          failures += 1;
          process.stderr.write(JSON.stringify({
            task_id: row.id,
            side,
            error: error instanceof Error ? error.message : "Photo reconciliation error",
          }) + "\n");
          continue;
        }
        if (!source) continue;
        const kind = sourceKind(source);
        if (!apply) {
          process.stdout.write(JSON.stringify({
            mode: "dry-run", task_id: row.id, side, source_kind: kind,
            action: kind === "cloudinary" ? "index_metadata" : "upload_to_cloudinary",
          }) + "\n");
          continue;
        }
        try {
          let secureUrl = source;
          let publicId = typeof raw[prefix + "_public_id"] === "string"
            ? String(raw[prefix + "_public_id"]) : null;
          let byteSize = typeof raw[prefix + "_size"] === "number" ? Number(raw[prefix + "_size"]) : null;
          let mimeType = typeof raw[prefix + "_mime_type"] === "string"
            ? String(raw[prefix + "_mime_type"]) : "image/jpeg";
          if (kind !== "cloudinary") {
            const uploaded = await uploadImageSource(
              source,
              "task-photos/" + String(row.zone_id) + "/" + row.id,
            );
            secureUrl = uploaded.secure_url;
            publicId = uploaded.public_id;
            byteSize = uploaded.bytes || byteSize || 0;
            mimeType = "image/" + (uploaded.format || "jpeg");
            replaceImageSource(raw, keys, nested, source, secureUrl);
            raw[prefix + "_url"] = secureUrl;
            raw[prefix + "_public_id"] = publicId;
            raw[prefix + "_size"] = byteSize;
            raw[prefix + "_mime_type"] = mimeType;
            raw[prefix + "_uploaded_at"] = new Date().toISOString();
            raw.photo_capture_status = "uploaded";
            await pool.query(
              "UPDATE task_instances SET raw_data = $2::jsonb, updated_at = NOW() WHERE id = $1",
              [row.id, JSON.stringify(raw)],
            );
            mediaMigrated += 1;
          }
          await pool.query(
            "INSERT INTO task_media (task_id, side, storage_provider, public_id, secure_url, mime_type, byte_size, captured_at, uploaded_at, metadata) " +
            "VALUES ($1,$2,'cloudinary',$3,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::jsonb) " +
            "ON CONFLICT (task_id, side) DO UPDATE SET storage_provider = 'cloudinary', " +
            "public_id = COALESCE(EXCLUDED.public_id, task_media.public_id), secure_url = EXCLUDED.secure_url, " +
            "mime_type = EXCLUDED.mime_type, byte_size = COALESCE(EXCLUDED.byte_size, task_media.byte_size), " +
            "captured_at = COALESCE(EXCLUDED.captured_at, task_media.captured_at), " +
            "uploaded_at = COALESCE(EXCLUDED.uploaded_at, task_media.uploaded_at), " +
            "metadata = EXCLUDED.metadata, updated_at = NOW()",
            [row.id, side, publicId, secureUrl, mimeType, byteSize,
              raw[prefix + "_taken_at"] || null,
              raw[prefix + "_uploaded_at"] || (kind === "cloudinary" ? null : new Date().toISOString()),
              JSON.stringify({ reconciled_by: "cloudinary_media_migration", source_kind: kind, side })],
          );
          mediaIndexed += 1;
        } catch (error) {
          failures += 1;
          process.stderr.write(JSON.stringify({
            task_id: row.id,
            side,
            source_kind: kind,
            error: error instanceof Error ? error.message : "Unknown migration error",
          }) + "\n");
        }
      }
    }
    const remaining = await pool.query<{ base64_tasks: number; firebase_url_tasks: number }>(
      "SELECT " +
      "(SELECT COUNT(*)::int FROM task_instances WHERE raw_data::text LIKE '%data:image/%') AS base64_tasks, " +
      "(SELECT COUNT(*)::int FROM task_instances WHERE raw_data::text ILIKE '%firebasestorage.googleapis.com%' OR raw_data::text ILIKE '%storage.googleapis.com%') AS firebase_url_tasks",
    );
    process.stdout.write(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      tasks_scanned: tasksScanned,
      media_migrated_to_cloudinary: mediaMigrated,
      media_metadata_indexed: mediaIndexed,
      failures,
      remaining_base64_tasks: Number(remaining.rows[0]?.base64_tasks || 0),
      remaining_firebase_url_tasks: Number(remaining.rows[0]?.firebase_url_tasks || 0),
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
