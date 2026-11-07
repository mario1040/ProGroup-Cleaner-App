import { describe, expect, it } from "vitest";
import {
  generateDailyTaskPlan,
  getArabicDayName,
  getSopOccurrencesForDate,
  selectFlexibleAssignee,
  type CleanerProfile,
  type RecurringSop,
  type ExistingTask,
} from "./task-engine";

const date = "2026-11-04"; // Wednesday
const profiles: CleanerProfile[] = [
  { id: "cleaner-b", role: "cleaner", is_active: true },
  { id: "cleaner-a", role: "cleaner", is_active: true },
  { id: "inactive", role: "cleaner", is_active: false },
  { id: "admin", role: "admin", is_active: true },
];

function sop(overrides: Partial<RecurringSop> = {}): RecurringSop {
  return {
    id: "sop-1",
    title: "Test cleaning task",
    zone_id: "zone-1",
    frequency: "يومي",
    is_active: true,
    ...overrides,
  };
}

describe("recurrence compatibility", () => {
  it("uses the correct Arabic weekday independent of server timezone", () => {
    expect(getArabicDayName(date)).toBe("الأربعاء");
  });

  it("generates daily tasks at each configured time", () => {
    expect(getSopOccurrencesForDate(sop({ scheduled_times: ["08:00", "12:00"] }), date)).toEqual([
      { time: "08:00", occurrenceIndex: 0 },
      { time: "12:00", occurrenceIndex: 1 },
    ]);
  });

  it("uses scheduled_time, then the legacy 09:00 default", () => {
    expect(getSopOccurrencesForDate(sop({ scheduled_time: "10:30" }), date)).toEqual([
      { time: "10:30", occurrenceIndex: 0 },
    ]);
    expect(getSopOccurrencesForDate(sop(), date)).toEqual([
      { time: "09:00", occurrenceIndex: 0 },
    ]);
  });

  it("generates weekly tasks only on configured Arabic weekdays", () => {
    expect(getSopOccurrencesForDate(sop({
      frequency: "أسبوعي",
      recurrence_days: ["الأربعاء"],
    }), date)).toHaveLength(1);
    expect(getSopOccurrencesForDate(sop({
      frequency: "أسبوعي",
      recurrence_days: ["الخميس"],
    }), date)).toHaveLength(0);
  });

  it("keeps the legacy every-other-day anchor rule", () => {
    const anchored = sop({
      frequency: "يوم ويوم",
      created_at: "2026-11-02T10:00:00.000Z",
    });
    expect(getSopOccurrencesForDate(anchored, date)).toHaveLength(1);
    expect(getSopOccurrencesForDate(anchored, "2026-11-05")).toHaveLength(0);
  });

  it("does not invent an every-other-day anchor when the source date is missing", () => {
    expect(getSopOccurrencesForDate(sop({ frequency: "يوم ويوم" }), date)).toHaveLength(0);
  });

  it("does not generate inactive or unsupported frequencies", () => {
    expect(getSopOccurrencesForDate(sop({ is_active: false }), date)).toHaveLength(0);
    expect(getSopOccurrencesForDate(sop({ frequency: "شهري" }), date)).toHaveLength(0);
  });
});

describe("assignment compatibility", () => {
  it("prioritizes the eligible default assignee", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop({ default_assignee_id: "cleaner-b" })],
      profiles,
      zones: [{ id: "zone-1", responsible_employee_id: "cleaner-a" }],
      existingTasks: [],
      now: new Date("2026-11-04T06:00:00.000Z"),
    });
    expect(result.generated[0].assigned_to).toBe("cleaner-b");
  });

  it("falls back to the zone responsible employee", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop({ default_assignee_id: "inactive" })],
      profiles,
      zones: [{ id: "zone-1", responsible_employee_id: "cleaner-a" }],
      existingTasks: [],
    });
    expect(result.generated[0].assigned_to).toBe("cleaner-a");
  });

  it("balances by task count and breaks ties by cleaner ID", () => {
    const tasks: ExistingTask[] = [
      { id: "x", assigned_to: "cleaner-a", due_date: date },
      { id: "y", assigned_to: "cleaner-b", due_date: date },
    ];
    expect(selectFlexibleAssignee(
      profiles.filter((profile) => profile.role === "cleaner" && profile.is_active),
      tasks,
      date,
    ).id).toBe("cleaner-a");
  });

  it("excludes inactive employees and non-cleaner roles", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop()],
      profiles: profiles.filter((profile) => profile.id === "inactive" || profile.id === "admin"),
      zones: [],
      existingTasks: [],
    });
    expect(result.generated).toHaveLength(0);
    expect(result.skippedNoEligibleCleaner).toBe(1);
  });

  it("includes earlier planned tasks in the workload of later generated tasks", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop({ id: "sop-a" }), sop({ id: "sop-b" }), sop({ id: "sop-c" })],
      profiles,
      zones: [],
      existingTasks: [],
    });
    expect(result.generated.map((task) => task.assigned_to)).toEqual([
      "cleaner-a", "cleaner-b", "cleaner-a",
    ]);
  });
});

describe("idempotency planning", () => {
  it("skips an existing deterministic ID", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop()],
      profiles,
      zones: [],
      existingTasks: [{
        id: "ti_rec_sop-1_2026-11-04_0",
        assigned_to: "cleaner-a",
        due_date: date,
      }],
    });
    expect(result.generated).toHaveLength(0);
    expect(result.skippedAlreadyExists).toBe(1);
  });

  it("recognizes the legacy ID format for the first occurrence", () => {
    const result = generateDailyTaskPlan({
      date,
      sops: [sop()],
      profiles,
      zones: [],
      existingTasks: [{
        id: "ti_rec_sop-1_2026-11-04",
        assigned_to: "cleaner-a",
        due_date: date,
      }],
    });
    expect(result.generated).toHaveLength(0);
    expect(result.skippedAlreadyExists).toBe(1);
  });
});
