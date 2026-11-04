import { describe, expect, it } from "vitest";
import { applyTaskUpdate, getTaskPhotoUrls, type TaskRecord } from "./task-rules";

const base: TaskRecord = {
  id: "task-1",
  status: "pending",
  task_type: "one_time",
  requires_photo_before: true,
  requires_photo_after: true,
  requires_supervisor_approval: true,
};

describe("task photo and lifecycle rules", () => {
  it("recognizes modern and legacy photo fields", () => {
    expect(getTaskPhotoUrls({
      ...base,
      photos: { before: "https://example.com/before.jpg", after: "https://example.com/after.jpg" },
    })).toEqual({
      before: "https://example.com/before.jpg",
      after: "https://example.com/after.jpg",
    });
  });

  it("blocks starting without a required before photo", () => {
    expect(() => applyTaskUpdate(base, { status: "in_progress" }, "2026-11-04T10:00:00.000Z"))
      .toThrow(/Before photo is required/);
  });

  it("blocks completion without an after photo", () => {
    const withBefore = { ...base, photo_before_url: "https://res.cloudinary.com/demo/before.jpg" };
    expect(() => applyTaskUpdate(withBefore, { status: "completed" }, "2026-11-04T10:00:00.000Z"))
      .toThrow(/After photo is required/);
  });

  it("blocks an after photo before a required before photo", () => {
    expect(() => applyTaskUpdate(base, { photo_after_url: "https://res.cloudinary.com/demo/after.jpg" }, "2026-11-04T10:00:00.000Z"))
      .toThrow(/cannot be added before/);
  });

  it("sets lifecycle timestamps and auto-approves tasks that do not require approval", () => {
    const ready = {
      ...base,
      requires_supervisor_approval: false,
      photo_before_url: "https://res.cloudinary.com/demo/before.jpg",
      photo_after_url: "https://res.cloudinary.com/demo/after.jpg",
    };
    const updated = applyTaskUpdate(ready, { status: "completed" }, "2026-11-04T10:00:00.000Z");
    expect(updated.completed_at).toBe("2026-11-04T10:00:00.000Z");
    expect(updated.supervisor_approved).toBe(true);
    expect(updated.quality_grade).toBe("A");
  });

  it("requires a parent reference for rework tasks", () => {
    expect(() => applyTaskUpdate({ ...base, task_type: "rework" }, {}, "2026-11-04T10:00:00.000Z"))
      .toThrow(/must reference its parent/);
  });

  it("prevents duplicate completion", () => {
    expect(() => applyTaskUpdate({ ...base, status: "completed" }, { status: "completed" }, "2026-11-04T10:00:00.000Z"))
      .toThrow(/already been completed/);
  });
});
