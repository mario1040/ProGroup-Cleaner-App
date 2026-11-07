import { describe, expect, it } from "vitest";
import { getTaskApprovalLabel, getTaskStatusLabel } from "../lib/task-status";

describe("shared Arabic task status labels", () => {
  it("uses the same wording for core task statuses", () => {
    expect(getTaskStatusLabel("pending")).toBe("بانتظار البدء");
    expect(getTaskStatusLabel("in_progress")).toBe("قيد التنفيذ");
    expect(getTaskStatusLabel("completed")).toBe("مكتملة");
    expect(getTaskStatusLabel("rejected")).toBe("مرفوضة – بحاجة لإعادة التنفيذ");
    expect(getTaskStatusLabel("late")).toBe("متأخرة");
    expect(getTaskStatusLabel("escalated")).toBe("مصعّدة");
  });

  it("keeps rework wording specific without changing the stored status", () => {
    expect(getTaskStatusLabel("pending", { taskType: "rework" })).toBe("إعادة تنفيذ");
    expect(getTaskStatusLabel("pending")).toBe("بانتظار البدء");
  });

  it("keeps supervisor approval separate from task completion", () => {
    expect(getTaskApprovalLabel(true)).toBe("معتمدة من المشرف");
    expect(getTaskApprovalLabel(false)).toBe("بانتظار اعتماد المشرف");
    expect(getTaskStatusLabel("completed")).toBe("مكتملة");
  });

  it("does not leak unknown backend status codes to the interface", () => {
    expect(getTaskStatusLabel("unexpected_status")).toBe("حالة غير معروفة");
  });
});
