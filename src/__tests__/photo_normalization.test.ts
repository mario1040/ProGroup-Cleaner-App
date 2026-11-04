import { describe, expect, it } from "vitest";
import { getTaskPhotoUrls, normalizeTaskPhotoUrls } from "../lib/api-postgres";
import { TaskInstance } from "../types";

const baseTask: TaskInstance = {
  id: "task-photo-test",
  zone_id: "z_reception",
  assigned_to: "p2",
  task_type: "recurring",
  title: "اختبار الصور",
  due_date: "2026-08-19",
  status: "completed",
  supervisor_approved: true
};

describe("Task photo URL normalization", () => {
  it("maps legacy nested photos into the current fields", () => {
    const normalized = normalizeTaskPhotoUrls({
      ...baseTask,
      photos: {
        before: "https://example.com/legacy-before.jpg",
        after: "https://example.com/legacy-after.jpg"
      }
    });

    expect(normalized.photo_before_url).toBe("https://example.com/legacy-before.jpg");
    expect(normalized.photo_after_url).toBe("https://example.com/legacy-after.jpg");
  });

  it("keeps current fields when both schemas are present", () => {
    const normalized = normalizeTaskPhotoUrls({
      ...baseTask,
      photo_before_url: "https://example.com/current-before.jpg",
      photo_after_url: "https://example.com/current-after.jpg",
      photos: {
        before: "https://example.com/legacy-before.jpg",
        after: "https://example.com/legacy-after.jpg"
      }
    });

    expect(normalized.photo_before_url).toBe("https://example.com/current-before.jpg");
    expect(normalized.photo_after_url).toBe("https://example.com/current-after.jpg");
  });

  it("supports all known legacy field names", () => {
    const urls = getTaskPhotoUrls({
      ...baseTask,
      before_photo_url: "https://example.com/before-photo-url.jpg",
      after_photo_url: "https://example.com/after-photo-url.jpg"
    });

    expect(urls.before).toBe("https://example.com/before-photo-url.jpg");
    expect(urls.after).toBe("https://example.com/after-photo-url.jpg");
  });

  it("ignores empty and unsupported URL values", () => {
    const urls = getTaskPhotoUrls({
      ...baseTask,
      photo_before_url: "",
      photo_after_url: "javascript:alert(1)",
      photos: {
        before: "https://example.com/fallback-before.jpg",
        after: ""
      }
    });

    expect(urls.before).toBe("https://example.com/fallback-before.jpg");
    expect(urls.after).toBeUndefined();
  });

  it("does not invent URLs when neither schema contains a photo", () => {
    const normalized = normalizeTaskPhotoUrls(baseTask);

    expect(normalized.photo_before_url).toBeUndefined();
    expect(normalized.photo_after_url).toBeUndefined();
  });
});
