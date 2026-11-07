export interface CleanerProfile {
  id: string;
  role: string;
  is_active: boolean;
}

export interface TaskZone {
  id: string;
  responsible_employee_id?: string | null;
}

export interface RecurringSop {
  id: string;
  title: string;
  zone_id: string;
  task_code?: string;
  description?: string;
  goal?: string;
  category?: string;
  tools_required?: string;
  frequency: string;
  recurrence_days?: string[] | null;
  scheduled_time?: string | null;
  scheduled_times?: string[] | null;
  estimated_duration_minutes?: number;
  default_assignee_id?: string | null;
  is_active: boolean;
  requires_photo_before?: boolean;
  requires_photo_after?: boolean;
  requires_supervisor_approval?: boolean;
  requires_gps?: boolean;
  guide_image_url?: string;
  reference_image_url?: string;
  created_at?: string;
}

export interface ExistingTask {
  id: string;
  assigned_to: string;
  due_date: string;
  task_type?: string;
}

export interface GeneratedTask {
  id: string;
  template_id: string;
  sop_item_id: string;
  zone_id: string;
  assigned_to: string;
  assigned_by: string;
  task_type: "recurring";
  title: string;
  description: string;
  goal: string;
  task_code: string;
  category: string;
  tools_required: string;
  estimated_duration_minutes: number;
  due_date: string;
  due_time: string;
  status: "pending";
  supervisor_approved: false;
  guide_image_url: string;
  reference_image_url: string;
  requires_photo_before: boolean;
  requires_photo_after: boolean;
  requires_supervisor_approval: boolean;
  requires_gps: boolean;
  requires_signature: false;
  occurrence_index: number;
  created_at: string;
  updated_at: string;
}

export interface TaskOccurrence {
  time: string;
  occurrenceIndex: number;
}

export interface GenerationInput {
  date: string;
  sops: RecurringSop[];
  profiles: CleanerProfile[];
  zones: TaskZone[];
  existingTasks: ExistingTask[];
  now?: Date;
}

export interface GenerationResult {
  date: string;
  generated: GeneratedTask[];
  skippedNoEligibleCleaner: number;
  skippedAlreadyExists: number;
}

const ARABIC_DAYS = [
  "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت",
] as const;

function parseDateOnly(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid date "' + date + '". Expected YYYY-MM-DD.');
  }
  const parts = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (
    parsed.getUTCFullYear() !== parts[0] ||
    parsed.getUTCMonth() !== parts[1] - 1 ||
    parsed.getUTCDate() !== parts[2]
  ) {
    throw new Error('Invalid calendar date "' + date + '".');
  }
  return parsed;
}

export function getArabicDayName(date: string): string {
  return ARABIC_DAYS[parseDateOnly(date).getUTCDay()];
}

export function getDaysDiff(date1: string, date2: string): number {
  const first = parseDateOnly(date1).getTime();
  const second = parseDateOnly(date2).getTime();
  return Math.floor(Math.abs(second - first) / 86_400_000);
}

export function generateTaskInstanceId(
  sopId: string,
  date: string,
  occurrenceIndex: number,
): string {
  return "ti_rec_" + sopId + "_" + date + "_" + occurrenceIndex;
}

/** Mirrors production recurrence rules; date parsing is independent of server timezone. */
export function getSopOccurrencesForDate(
  sop: RecurringSop,
  date: string,
): TaskOccurrence[] {
  if (sop.is_active !== true) return [];

  const dayName = getArabicDayName(date);
  const times =
    sop.scheduled_times && sop.scheduled_times.length > 0
      ? sop.scheduled_times
      : sop.scheduled_time
        ? [sop.scheduled_time]
        : ["09:00"];

  switch (sop.frequency) {
    case "يومي":
    case "ثلاث مرات يوميا":
      return times.map((time, occurrenceIndex) => ({ time, occurrenceIndex }));

    case "يوم ويوم":
    case "يوم و يوم": {
      const createdDate = sop.created_at?.slice(0, 10);
      if (!createdDate || !/^\\d{4}-\\d{2}-\\d{2}$/.test(createdDate)) return [];
      return getDaysDiff(createdDate, date) % 2 === 0
        ? times.map((time, occurrenceIndex) => ({ time, occurrenceIndex }))
        : [];
    }

    case "أسبوعي":
    case "مرتين أسبوعيا":
    case "ثلاث مرات أسبوعيا":
      return sop.recurrence_days?.includes(dayName)
        ? times.map((time, occurrenceIndex) => ({ time, occurrenceIndex }))
        : [];

    default:
      return [];
  }
}

export function isEligibleCleaner(profile: CleanerProfile): boolean {
  return profile.role === "cleaner" && profile.is_active === true;
}

export function getEligibleCleaners(profiles: CleanerProfile[]): CleanerProfile[] {
  return profiles.filter(isEligibleCleaner);
}

/** Fewest assigned tasks for this date, then deterministic employee-ID tie-break. */
export function selectFlexibleAssignee(
  eligibleCleaners: CleanerProfile[],
  existingTasks: ExistingTask[],
  date: string,
): CleanerProfile {
  if (eligibleCleaners.length === 0) {
    throw new Error("No active cleaners are available for task assignment.");
  }

  return [...eligibleCleaners].sort((left, right) => {
    const leftCount = existingTasks.filter(
      (task) => task.assigned_to === left.id && task.due_date === date,
    ).length;
    const rightCount = existingTasks.filter(
      (task) => task.assigned_to === right.id && task.due_date === date,
    ).length;
    return leftCount - rightCount || left.id.localeCompare(right.id);
  })[0];
}

function resolveAssignee(
  sop: RecurringSop,
  profiles: CleanerProfile[],
  zones: TaskZone[],
  existingTasks: ExistingTask[],
  date: string,
): string | null {
  const eligible = getEligibleCleaners(profiles);
  const eligibleIds = new Set(eligible.map((profile) => profile.id));

  // Priority 1: SOP default assignee.
  if (sop.default_assignee_id && eligibleIds.has(sop.default_assignee_id)) {
    return sop.default_assignee_id;
  }

  // Priority 2: responsible employee for the SOP zone.
  const zone = zones.find((item) => item.id === sop.zone_id);
  if (zone?.responsible_employee_id && eligibleIds.has(zone.responsible_employee_id)) {
    return zone.responsible_employee_id;
  }

  // Priority 3: least-loaded active cleaner.
  if (eligible.length === 0) return null;
  return selectFlexibleAssignee(eligible, existingTasks, date).id;
}

export function buildTaskInstanceSnapshot(
  sop: RecurringSop,
  date: string,
  occurrence: TaskOccurrence,
  assignedTo: string,
  now: Date = new Date(),
): GeneratedTask {
  const timestamp = now.toISOString();

  return {
    id: generateTaskInstanceId(sop.id, date, occurrence.occurrenceIndex),
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
    due_date: date,
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
    occurrence_index: occurrence.occurrenceIndex,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** Pure planner: it never writes to the database and is safe to dry-run. */
export function generateDailyTaskPlan(input: GenerationInput): GenerationResult {
  parseDateOnly(input.date);
  const now = input.now ?? new Date();
  const workload: ExistingTask[] = [...input.existingTasks];
  const existingIds = new Set(input.existingTasks.map((task) => task.id));
  const generated: GeneratedTask[] = [];
  let skippedNoEligibleCleaner = 0;
  let skippedAlreadyExists = 0;

  for (const sop of input.sops) {
    for (const occurrence of getSopOccurrencesForDate(sop, input.date)) {
      const id = generateTaskInstanceId(sop.id, input.date, occurrence.occurrenceIndex);
      const legacyId = "ti_rec_" + sop.id + "_" + input.date;

      if (existingIds.has(id) || (occurrence.occurrenceIndex === 0 && existingIds.has(legacyId))) {
        skippedAlreadyExists += 1;
        continue;
      }

      const assignedTo = resolveAssignee(
        sop, input.profiles, input.zones, workload, input.date,
      );

      if (!assignedTo) {
        skippedNoEligibleCleaner += 1;
        continue;
      }

      const task = buildTaskInstanceSnapshot(sop, input.date, occurrence, assignedTo, now);
      generated.push(task);
      existingIds.add(task.id);
      workload.push({
        id: task.id,
        assigned_to: task.assigned_to,
        due_date: task.due_date,
        task_type: task.task_type,
      });
    }
  }

  return { date: input.date, generated, skippedNoEligibleCleaner, skippedAlreadyExists };
}
