export interface TaskStatusLabelOptions {
  taskType?: string | null;
}

/**
 * Single Arabic wording source for task statuses across desktop and mobile.
 * Supervisor approval is a separate state and must not be conflated with completion.
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
      return "مكتملة";
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

export function getTaskApprovalLabel(supervisorApproved?: boolean | null): string {
  return supervisorApproved === true ? "معتمدة من المشرف" : "بانتظار اعتماد المشرف";
}
