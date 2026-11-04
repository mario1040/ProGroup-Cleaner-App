export interface TaskRecord extends Record<string, unknown> {
  id: string;
  status: string;
  task_type?: string;
  parent_instance_id?: string | null;
  requires_photo_before?: boolean;
  requires_photo_after?: boolean;
  requires_supervisor_approval?: boolean;
  photo_before_url?: string | null;
  photo_after_url?: string | null;
  photos?: { before?: string; after?: string; before_url?: string; after_url?: string };
  before_photo_url?: string;
  after_photo_url?: string;
  before_photo?: string;
  after_photo?: string;
  photoBefore?: string;
  photoAfter?: string;
  started_at?: string;
  completed_at?: string;
  supervisor_approved?: boolean;
  quality_grade?: string;
}

export type TaskUpdate = Partial<TaskRecord>;

function usableImage(value: unknown): value is string {
  return typeof value === "string" &&
    (value.startsWith("https://") || value.startsWith("data:image/"));
}

export function getTaskPhotoUrls(task: TaskRecord): { before?: string; after?: string } {
  const beforeCandidates = [
    task.photo_before_url, task.photos?.before, task.photos?.before_url,
    task.before_photo_url, task.before_photo, task.photoBefore,
  ];
  const afterCandidates = [
    task.photo_after_url, task.photos?.after, task.photos?.after_url,
    task.after_photo_url, task.after_photo, task.photoAfter,
  ];
  return {
    before: beforeCandidates.find(usableImage),
    after: afterCandidates.find(usableImage),
  };
}

/** Enforces the task photo and lifecycle invariants used by the existing client API. */
export function applyTaskUpdate(
  current: TaskRecord,
  updates: TaskUpdate,
  now: string,
): TaskRecord {
  if (current.status === "completed" && updates.status === "completed") {
    throw new Error("Task has already been completed.");
  }

  const merged = { ...current, ...updates, updated_at: now } as TaskRecord;
  const photos = getTaskPhotoUrls(merged);
  const requiresBefore = merged.requires_photo_before !== false;
  const requiresAfter = merged.requires_photo_after !== false;

  if (requiresBefore &&
      (updates.status === "in_progress" || updates.status === "completed" || merged.status === "completed") &&
      !photos.before) {
    throw new Error("Before photo is required before starting or completing this task.");
  }
  if (requiresAfter && (updates.status === "completed" || merged.status === "completed") && !photos.after) {
    throw new Error("After photo is required before completing this task.");
  }
  if (photos.after && requiresBefore && !photos.before) {
    throw new Error("After photo cannot be added before the before photo.");
  }
  if (merged.task_type === "rework" && !merged.parent_instance_id) {
    throw new Error("A rework task must reference its parent task.");
  }

  if (updates.photo_before_url && !current.photo_before_url) {
    merged.photo_before_taken_at = updates.photo_before_taken_at || now;
    merged.photo_before_uploaded_at = updates.photo_before_uploaded_at || now;
  }
  if (updates.status === "in_progress" && !current.started_at) {
    merged.started_at = now;
  }
  if (updates.status === "completed" && !current.completed_at) {
    merged.completed_at = now;
    merged.photo_after_taken_at = merged.photo_after_taken_at || updates.photo_after_taken_at || now;
    merged.photo_after_uploaded_at = updates.photo_after_uploaded_at || now;
    if (merged.requires_supervisor_approval === false) {
      merged.supervisor_approved = true;
      merged.supervisor_approved_at = now;
      merged.quality_grade = "A";
    }
  }
  return merged;
}
