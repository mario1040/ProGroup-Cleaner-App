import type { Profile, SOPItem, TaskInstance } from "../types";

export function getArabicDayName(dateStr?: string): string {
  const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  if (!dateStr) return days[new Date().getDay()];
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    const year = Number.parseInt(parts[0], 10);
    const month = Number.parseInt(parts[1], 10) - 1;
    const day = Number.parseInt(parts[2], 10);
    return days[new Date(year, month, day).getDay()];
  }
  return days[new Date(dateStr).getDay()];
}

export function getDaysDiff(dateStr1: string, dateStr2: string): number {
  const parseParts = (value: string) => {
    const parts = value.split("-");
    if (parts.length === 3) {
      return {
        year: Number.parseInt(parts[0], 10),
        month: Number.parseInt(parts[1], 10) - 1,
        day: Number.parseInt(parts[2], 10),
      };
    }
    const date = new Date(value);
    return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
  };
  const first = parseParts(dateStr1);
  const second = parseParts(dateStr2);
  const firstUtc = Date.UTC(first.year, first.month, first.day);
  const secondUtc = Date.UTC(second.year, second.month, second.day);
  return Math.floor(Math.abs(secondUtc - firstUtc) / 86_400_000);
}

export function getSopOccurrencesForDate(
  sop: SOPItem,
  dateStr: string,
): { time: string; occurrenceIndex: number }[] {
  if (!sop.is_active) return [];
  const dayName = getArabicDayName(dateStr);
  const times = sop.scheduled_times?.length
    ? [...sop.scheduled_times]
    : [sop.scheduled_time || "09:00"];
  const occurrences: { time: string; occurrenceIndex: number }[] = [];
  switch (sop.frequency) {
    case "يومي":
    case "ثلاث مرات يوميا":
      times.forEach((time, index) => occurrences.push({ time, occurrenceIndex: index }));
      break;
    case "يوم ويوم":
    case "يوم و يوم": {
      const createdDate = sop.created_at?.split("T")[0] || "2026-07-01";
      if (getDaysDiff(createdDate, dateStr) % 2 === 0) {
        times.forEach((time, index) => occurrences.push({ time, occurrenceIndex: index }));
      }
      break;
    }
    case "أسبوعي":
    case "مرتين أسبوعيا":
    case "ثلاث مرات أسبوعيا":
      if (sop.recurrence_days?.includes(dayName)) {
        times.forEach((time, index) => occurrences.push({ time, occurrenceIndex: index }));
      }
      break;
    default:
      return [];
  }
  return occurrences;
}

export function generateTaskInstanceId(sopId: string, dateStr: string, occurrenceIndex: number): string {
  return "ti_rec_" + sopId + "_" + dateStr + "_" + occurrenceIndex;
}

export function buildTaskInstanceSnapshot(
  sop: SOPItem,
  dateStr: string,
  occurrence: { time: string; occurrenceIndex: number },
  assignedTo: string,
): TaskInstance {
  const now = new Date().toISOString();
  return {
    id: generateTaskInstanceId(sop.id, dateStr, occurrence.occurrenceIndex),
    template_id: sop.id,
    sop_item_id: sop.id,
    zone_id: sop.zone_id,
    assigned_to: assignedTo,
    assigned_by: "p1",
    task_type: "recurring",
    title: sop.title,
    description: sop.description || "",
    goal: sop.goal || "",
    task_code: sop.task_code || "",
    category: sop.category || "تشغيل",
    tools_required: sop.tools_required || "",
    estimated_duration_minutes: sop.estimated_duration_minutes || 0,
    due_date: dateStr,
    due_time: occurrence.time,
    status: "pending",
    supervisor_approved: false,
    guide_image_url: sop.guide_image_url || "",
    reference_image_url: sop.reference_image_url || "",
    requires_photo_before: sop.requires_photo_before ?? true,
    requires_photo_after: sop.requires_photo_after ?? true,
    requires_supervisor_approval: sop.requires_supervisor_approval ?? true,
    requires_gps: sop.requires_gps ?? false,
    requires_signature: false,
    created_at: now,
    updated_at: now,
  };
}

export function selectFlexibleAssignee(
  eligibleCleaners: Profile[],
  existingInstances: TaskInstance[],
  dateStr?: string,
): Profile {
  if (eligibleCleaners.length === 0) {
    throw new Error("لا يوجد موظفون نشطون متاحون لإسناد المهمة.");
  }
  let bestCleaner = eligibleCleaners[0];
  let minTasks = Number.POSITIVE_INFINITY;
  for (const cleaner of eligibleCleaners) {
    const taskCount = existingInstances.filter(
      (task) => task.assigned_to === cleaner.id && (!dateStr || task.due_date === dateStr),
    ).length;
    if (taskCount < minTasks || (taskCount === minTasks && cleaner.id < bestCleaner.id)) {
      minTasks = taskCount;
      bestCleaner = cleaner;
    }
  }
  return bestCleaner;
}
