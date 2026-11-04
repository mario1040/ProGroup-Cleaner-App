// src/lib/cloudinary.ts
// Cloudinary upload client for task and reference media.

const CLOUDINARY_CLOUD_NAME = String(import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || "").trim();
const CLOUDINARY_UPLOAD_PRESET = String(import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "").trim();

function assertCloudinaryConfiguration(): void {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    throw new Error("إعدادات رفع الصور غير مكتملة. أضف VITE_CLOUDINARY_CLOUD_NAME وVITE_CLOUDINARY_UPLOAD_PRESET إلى بيئة التشغيل.");
  }
}

export interface CloudinaryUploadResult {
  url: string;
  secure_url: string;
  public_id: string;
  format: string;
  bytes: number;
}

function base64ToBlob(base64: string, defaultMime = "image/jpeg"): Blob {
  try {
    const arr = base64.split(",");
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : defaultMime;
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (err) {
    console.error("[Cloudinary] Failed to convert Base64 to Blob:", err);
    throw new Error("فشل تحويل الصورة إلى صيغة ملف قابلة للرفع.");
  }
}

export async function uploadToCloudinary(
  blobOrBase64: Blob | string,
  folder: string = "naris_ops"
): Promise<CloudinaryUploadResult> {
  let file: File | Blob;

  if (typeof blobOrBase64 === "string") {
    file = base64ToBlob(blobOrBase64, "image/jpeg");
  } else {
    file = blobOrBase64;
  }

  assertCloudinaryConfiguration();

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);
  formData.append("tags", "naris-ops,production");

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    {
      method: "POST",
      body: formData,
    }
  );

  if (!response.ok) {
    let message = response.statusText || "تعذر رفع الصورة";
    try {
      const errorData = await response.json();
      message = errorData?.error?.message || message;
    } catch {
      // Keep the HTTP status message when Cloudinary returns a non-JSON error.
    }
    throw new Error(`Cloudinary upload failed: ${message}`);
  }

  const data = await response.json();
  if (!data?.secure_url || !data?.public_id) {
    throw new Error("استجابة Cloudinary غير مكتملة ولم يتم حفظ رابط الصورة بأمان.");
  }
  return {
    url: data.url,
    secure_url: data.secure_url,
    public_id: data.public_id,
    format: data.format,
    bytes: data.bytes,
  };
}

export interface CloudinaryOrphanRecord {
  public_id: string;
  secure_url: string;
  folder: string;
  timestamp: string;
  reason: string;
}

const orphanCandidates: CloudinaryOrphanRecord[] = [];

export function recordOrphanCandidate(
  publicId: string,
  secureUrl: string,
  folder: string,
  reason: string
): void {
  const record: CloudinaryOrphanRecord = {
    public_id: publicId,
    secure_url: secureUrl,
    folder,
    timestamp: new Date().toISOString(),
    reason,
  };
  orphanCandidates.push(record);
  console.info("[Cloudinary Cleanup] Logged uncommitted or replaced orphan asset candidate:", record);
}

export function getOrphanCandidates(): CloudinaryOrphanRecord[] {
  return [...orphanCandidates];
}

export async function deleteFromCloudinary(publicId: string): Promise<void> {
  // Client-side browser execution cannot safely contain Cloudinary API secrets.
  // We record the deletion intent and public_id for server/admin cleanup workflows.
  recordOrphanCandidate(publicId, "", "manual_delete", "User requested photo deletion");
  console.warn(
    `[Cloudinary Cleanup] Direct client-side deletion requires admin secret which is forbidden in frontend. Public ID queued for server-side maintenance: ${publicId}`
  );
}

export function getCloudinaryUrl(
  publicId: string,
  options?: { width?: number; height?: number; quality?: number; format?: string }
): string {
  let transformations = "";
  if (options) {
    const t: string[] = [];
    if (options.width) t.push(`w_${options.width}`);
    if (options.height) t.push(`h_${options.height}`);
    if (options.quality) t.push(`q_${options.quality}`);
    if (options.format) t.push(`f_${options.format}`);
    if (t.length > 0) transformations = t.join(",") + "/";
  }
  if (!CLOUDINARY_CLOUD_NAME) return "";
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/${transformations}${publicId}`;
}

/** Fetch a remote image as a data URL for reliable canvas/PDF rendering. */
export async function imageUrlToDataUrl(url: string): Promise<string | null> {
  if (!url) return null;
  if (url.startsWith("data:image/")) return url;

  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.warn("[Cloudinary] Could not convert image for export:", url, error);
    return null;
  }
}

export function isUsableImageUrl(url: unknown): url is string {
  return typeof url === "string" &&
    (url.startsWith("https://") || url.startsWith("data:image/"));
}