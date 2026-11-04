import type {
  DeviceSwitch,
  InventoryItem,
  OperationalTask,
  Profile,
  SOPItem,
  TaskInstance,
  TaskTemplate,
  Zone,
} from "../types";
import { uploadToCloudinary } from "./cloudinary";

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "https://naris-api.bezaverse.com").replace(/\/$/, "");

type ApiEnvelope<T> = { data: T; meta?: Record<string, unknown> };

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(API_BASE_URL + path, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: text }; }
  }
  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : "API request failed (" + response.status + ")";
    throw new Error(error);
  }
  return payload as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export interface KpiSummary {
  profile_id: string;
  cleaner_name: string;
  username: string;
  tasks_assigned: number;
  tasks_completed_on_time: number;
  tasks_late: number;
  tasks_reworked: number;
  tasks_rejected: number;
  compliance_rate: number;
  avg_execution_time_minutes: number;
  quality_score: number;
  supervisor_rating: number;
}

export interface DatabaseValidationReport {
  timestamp: string;
  isPassed: boolean;
  summary: {
    totalCollectionsChecked: number;
    totalDocumentsChecked: number;
    totalErrors: number;
    totalWarnings: number;
  };
  details: {
    collectionName: string;
    totalDocs: number;
    passedDocs: number;
    failedDocs: number;
    errors: string[];
    warnings: string[];
  }[];
}

export function getLocalDateString(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

export function isEligibleCleaner(profile: Profile | Partial<Profile>): boolean {
  return profile.role === "cleaner" && profile.is_active === true;
}

export function getEligibleCleaners(profiles: Profile[]): Profile[] {
  return profiles.filter(isEligibleCleaner);
}

export function getTaskPhotoUrls(task: TaskInstance): { before?: string; after?: string } {
  const record = task as TaskInstance & {
    photos?: { before?: string; after?: string; before_url?: string; after_url?: string };
    before_photo_url?: string; after_photo_url?: string;
    before_photo?: string; after_photo?: string;
    photoBefore?: string; photoAfter?: string;
  };
  const usable = (value: unknown): value is string =>
    typeof value === "string" && (value.startsWith("https://") || value.startsWith("data:image/"));
  return {
    before: [
      record.photo_before_url, record.photos?.before, record.photos?.before_url,
      record.before_photo_url, record.before_photo, record.photoBefore,
    ].find(usable),
    after: [
      record.photo_after_url, record.photos?.after, record.photos?.after_url,
      record.after_photo_url, record.after_photo, record.photoAfter,
    ].find(usable),
  };
}

export function normalizeTaskPhotoUrls<T extends TaskInstance>(task: T): T {
  const urls = getTaskPhotoUrls(task);
  return { ...task, photo_before_url: urls.before, photo_after_url: urls.after };
}

export async function loginUser(identifier: string, password?: string): Promise<Profile> {
  if (!password) throw new Error("يرجى إدخال كلمة المرور");
  const result = await apiRequest<{ user: Profile }>("/api/auth/login", {
    method: "POST",
    body: jsonBody({ identifier, password }),
  });
  return result.user;
}

export async function getCurrentUserProfile(_email?: string): Promise<Profile | null> {
  try {
    const result = await apiRequest<{ user: Profile }>("/api/auth/me");
    return result.user;
  } catch (error) {
    if (error instanceof Error && error.message.includes("401")) return null;
    return null;
  }
}

export async function logoutUser(): Promise<void> {
  await apiRequest("/api/auth/logout", { method: "POST", body: "{}" });
}

export async function getProfiles(): Promise<Profile[]> {
  const result = await apiRequest<ApiEnvelope<Profile[]>>("/api/users");
  return result.data;
}

export async function getRawZones(): Promise<Zone[]> {
  const result = await apiRequest<ApiEnvelope<Zone[]>>("/api/zones");
  return result.data;
}

export async function getZones(): Promise<(Zone & { responsible_employee?: Profile })[]> {
  const [zones, profiles] = await Promise.all([
    getRawZones(),
    getProfiles().catch(() => [] as Profile[]),
  ]);
  return zones.map((zone) => ({
    ...zone,
    responsible_employee: profiles.find((profile) => profile.id === zone.responsible_employee_id),
  })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

export async function getSopItems(): Promise<SOPItem[]> {
  const result = await apiRequest<ApiEnvelope<SOPItem[]>>("/api/sop-items");
  return result.data;
}

export async function getTemplates(): Promise<TaskTemplate[]> {
  const result = await apiRequest<ApiEnvelope<TaskTemplate[]>>("/api/task-templates");
  return result.data;
}

export async function getOperationalTasks(): Promise<(OperationalTask & { responsible_employee?: Profile })[]> {
  const [result, profiles] = await Promise.all([
    apiRequest<ApiEnvelope<OperationalTask[]>>("/api/operational-tasks"),
    getProfiles().catch(() => [] as Profile[]),
  ]);
  return result.data.map((task) => ({
    ...task,
    responsible_employee: profiles.find((profile) => profile.id === task.responsible_employee_id),
  }));
}

export async function getInventoryItems(): Promise<InventoryItem[]> {
  const result = await apiRequest<ApiEnvelope<InventoryItem[]>>("/api/inventory-items");
  return result.data;
}

export async function createInventoryItem(
  item: Omit<InventoryItem, "id" | "last_updated" | "status">,
): Promise<InventoryItem> {
  const result = await apiRequest<{ data: InventoryItem }>("/api/inventory-items", {
    method: "POST",
    body: jsonBody(item),
  });
  return result.data;
}

export async function updateInventoryItem(
  id: string,
  updates: Partial<Pick<InventoryItem, "name" | "category" | "quantity" | "min_quantity">>,
): Promise<InventoryItem> {
  const result = await apiRequest<{ data: InventoryItem }>("/api/inventory-items/" + encodeURIComponent(id), {
    method: "PATCH",
    body: jsonBody(updates),
  });
  return result.data;
}

export async function deleteInventoryItem(id: string): Promise<void> {
  await apiRequest("/api/inventory-items/" + encodeURIComponent(id), { method: "DELETE" });
}

export async function getDeviceSwitches(): Promise<DeviceSwitch[]> {
  const result = await apiRequest<ApiEnvelope<DeviceSwitch[]>>("/api/device-switches");
  return result.data;
}

async function enrichTasks(tasks: TaskInstance[]): Promise<(TaskInstance & {
  zone?: Zone; assignee?: Profile; template?: TaskTemplate;
})[]> {
  const [zones, profiles, templates, currentUser] = await Promise.all([
    getRawZones().catch(() => [] as Zone[]),
    getProfiles().catch(() => [] as Profile[]),
    getTemplates().catch(() => [] as TaskTemplate[]),
    getCurrentUserProfile(),
  ]);
  const usableProfiles = profiles.length ? profiles : (currentUser ? [currentUser] : []);
  return tasks.map((task) => ({
    ...normalizeTaskPhotoUrls(task),
    zone: zones.find((zone) => zone.id === task.zone_id),
    assignee: usableProfiles.find((profile) => profile.id === task.assigned_to),
    template: templates.find((template) => template.id === (task.sop_item_id || task.template_id)),
  }));
}

export async function getTasks(dateStr = getLocalDateString()): Promise<(TaskInstance & {
  zone?: Zone; assignee?: Profile; template?: TaskTemplate;
})[]> {
  const result = await apiRequest<ApiEnvelope<TaskInstance[]>>(
    "/api/tasks?date=" + encodeURIComponent(dateStr) + "&limit=500",
  );
  return enrichTasks(result.data);
}

export async function getTasksForRange(startDate: string, endDate: string): Promise<(TaskInstance & {
  zone?: Zone; assignee?: Profile; template?: TaskTemplate;
})[]> {
  const result = await apiRequest<ApiEnvelope<TaskInstance[]>>(
    "/api/tasks?startDate=" + encodeURIComponent(startDate) +
    "&endDate=" + encodeURIComponent(endDate) + "&limit=500",
  );
  return enrichTasks(result.data);
}

export function listenTasksForDate(
  dateStr: string,
  userId: string | undefined,
  callback: (tasks: (TaskInstance & { zone?: Zone; assignee?: Profile; template?: TaskTemplate })[]) => void,
): () => void {
  let stopped = false;
  const refresh = async () => {
    try {
      const tasks = await getTasks(dateStr);
      if (!stopped) callback(userId ? tasks.filter((task) => task.assigned_to === userId) : tasks);
    } catch (error) {
      console.error("[PostgreSQL task polling]", error);
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 15000);
  return () => { stopped = true; window.clearInterval(timer); };
}

export function listenTodayTasks(
  userId: string | undefined,
  callback: (tasks: (TaskInstance & { zone?: Zone; assignee?: Profile; template?: TaskTemplate })[]) => void,
): () => void {
  return listenTasksForDate(getLocalDateString(), userId, callback);
}

export async function createTask(task: Partial<TaskInstance>): Promise<TaskInstance> {
  const result = await apiRequest<{ data: TaskInstance }>("/api/tasks", {
    method: "POST", body: jsonBody(task),
  });
  return result.data;
}

export async function updateTask(id: string, updates: Partial<TaskInstance>): Promise<TaskInstance> {
  const result = await apiRequest<{ data: TaskInstance }>("/api/tasks/" + encodeURIComponent(id), {
    method: "PATCH", body: jsonBody(updates),
  });
  return result.data;
}

export async function approveTask(
  id: string,
  approval: { supervisor_id: string; quality_grade: "A" | "B" | "C"; supervisor_notes?: string },
): Promise<TaskInstance> {
  const result = await apiRequest<{ data: TaskInstance }>("/api/tasks/" + encodeURIComponent(id) + "/approve", {
    method: "POST", body: jsonBody(approval),
  });
  return result.data;
}

export async function rejectTask(
  id: string,
  rejection: { supervisor_id: string; supervisor_notes: string },
): Promise<{ original: TaskInstance; rework: TaskInstance }> {
  const result = await apiRequest<{ data: { original: TaskInstance; rework: TaskInstance } }>(
    "/api/tasks/" + encodeURIComponent(id) + "/reject",
    { method: "POST", body: jsonBody(rejection) },
  );
  return result.data;
}

export async function saveTemplate(template: Partial<TaskTemplate>): Promise<TaskTemplate> {
  const path = template.id
    ? "/api/task-templates/" + encodeURIComponent(template.id)
    : "/api/task-templates";
  const { id, ...payload } = template;
  const result = await apiRequest<{ data: TaskTemplate }>(path, {
    method: id ? "PATCH" : "POST",
    body: jsonBody(payload),
  });
  return result.data;
}

export async function deleteTemplate(id: string): Promise<void> {
  await apiRequest("/api/task-templates/" + encodeURIComponent(id), { method: "DELETE" });
}

export async function saveProfile(profile: Partial<Profile>): Promise<{ profile: Profile; generatedPassword?: string }> {
  const { id, ...payload } = profile;
  const path = id ? "/api/users/" + encodeURIComponent(id) : "/api/users";
  const result = await apiRequest<{ profile: Profile; generatedPassword?: string }>(path, {
    method: id ? "PATCH" : "POST",
    body: jsonBody(payload),
  });
  return result;
}

export async function provisionEmployeeAuth(profileId: string): Promise<string> {
  const result = await apiRequest<{ generatedPassword: string }>(
    "/api/users/" + encodeURIComponent(profileId) + "/reset-password",
    { method: "POST", body: "{}" },
  );
  return result.generatedPassword;
}

export async function reassignPendingTasksFromInactiveCleaner(
  profileId: string,
): Promise<{ updated: number; skipped: number }> {
  return apiRequest("/api/users/" + encodeURIComponent(profileId) + "/reassign-pending", {
    method: "POST", body: "{}",
  });
}

export async function validateDatabase(): Promise<DatabaseValidationReport> {
  return apiRequest("/api/system/validation");
}

export async function saveZone(zone: Partial<Zone>): Promise<Zone> {
  const { id, ...payload } = zone;
  const path = id ? "/api/zones/" + encodeURIComponent(id) : "/api/zones";
  const result = await apiRequest<{ data: Zone }>(path, {
    method: id ? "PATCH" : "POST",
    body: jsonBody(payload),
  });
  return result.data;
}

export async function getKpis(dateRange?: { startDate?: string; endDate?: string }): Promise<KpiSummary[]> {
  const params = new URLSearchParams();
  if (dateRange?.startDate) params.set("startDate", dateRange.startDate);
  if (dateRange?.endDate) params.set("endDate", dateRange.endDate);
  const result = await apiRequest<ApiEnvelope<KpiSummary[]>>(
    "/api/kpis" + (params.size ? "?" + params.toString() : ""),
  );
  return result.data;
}

export async function uploadPhoto(blobOrBase64: Blob | string, path: string): Promise<string> {
  const folder = path.split("/").slice(0, -1).join("/") || "naris_ops";
  const result = await uploadToCloudinary(blobOrBase64, folder);
  return result.secure_url;
}

export async function deletePhoto(publicId: string, taskId: string): Promise<void> {
  if (!publicId || !taskId) return;
  await apiRequest("/api/media/delete", {
    method: "POST",
    body: jsonBody({ public_id: publicId, task_id: taskId }),
  });
}

export function compressImage(
  base64Str: string,
  maxWidth = 1600,
  maxHeight = 1600,
  quality = 0.75,
): Promise<string> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof Image === "undefined") {
      resolve(base64Str); return;
    }
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      if (width > height && width > maxWidth) {
        height = Math.round((height * maxWidth) / width); width = maxWidth;
      } else if (height >= width && height > maxHeight) {
        width = Math.round((width * maxHeight) / height); height = maxHeight;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) { resolve(base64Str); return; }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}
