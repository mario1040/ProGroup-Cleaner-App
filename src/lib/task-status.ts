export interface TaskStatusLabelOptions {
  taskType?: string | null;
  supervisorApproved?: boolean | null;
}

/**
 * Single Arabic wording source for task statuses across desktop and mobile.
 * Completion and supervisor approval are deliberately represented separately.
 */
export function getTaskStatusLabel(
  status: string,
  options: TaskStatusLabelOptions = {},
): string {
  if (options.taskType === "rework" && status === "pending") {
    return "إعادة تنفيذ";
  }

  switch (status) {
    case "pending":
      return "بانتظار البدء";
    case "in_progress":
      return "قيد التنفيذ";
    case "completed":
      return options.supervisorApproved === true
        ? "مكتملة ومعتمدة"
        : "مكتملة – بانتظار اعتماد المشرف";
    case "rejected":
      return "مرفوضة – بحاجة لإعادة التنفيذ";
    case "late":
      return "متأخرة";
    case "escalated":
      return "مصعّدة";
    default:
      return "حالة غير معروفة";
  }
}
