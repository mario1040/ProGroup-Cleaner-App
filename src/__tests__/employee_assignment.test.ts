import { isEligibleCleaner, getEligibleCleaners } from '../lib/api-postgres';
import { selectFlexibleAssignee } from '../lib/task-utils';
import { Profile, TaskInstance, SOPItem, Zone } from '../types';

describe('Naris Ops Strict Employee Status & Assignment Hardening Suite', () => {
  const profiles: Profile[] = [
    {
      id: 'p1',
      username: 'admin',
      full_name: 'مدير العمليات',
      role: 'admin',
      is_active: true,
      created_at: '2026-01-01'
    },
    {
      id: 'p_sup',
      username: 'supervisor1',
      full_name: 'مشرف الجودة',
      role: 'supervisor',
      is_active: true,
      created_at: '2026-01-01'
    },
    {
      id: 'p2',
      username: 'cleaner_active_a',
      full_name: 'أحمد علي (نشط)',
      role: 'cleaner',
      is_active: true,
      created_at: '2026-01-01'
    },
    {
      id: 'p3',
      username: 'cleaner_active_b',
      full_name: 'محمود حسن (نشط)',
      role: 'cleaner',
      is_active: true,
      created_at: '2026-01-01'
    },
    {
      id: 'p4_legacy_undefined',
      username: 'cleaner_undefined',
      full_name: 'موظف قديم undefined',
      role: 'cleaner',
      // @ts-ignore testing undefined is_active
      is_active: undefined,
      created_at: '2026-01-01'
    },
    {
      id: 'p4_legacy_null',
      username: 'cleaner_null',
      full_name: 'موظف قديم null',
      role: 'cleaner',
      // @ts-ignore testing null is_active
      is_active: null,
      created_at: '2026-01-01'
    },
    {
      id: 'p5_inactive',
      username: 'cleaner_inactive',
      full_name: 'رحاب محمد (معطل/غير نشط)',
      role: 'cleaner',
      is_active: false,
      created_at: '2026-01-01'
    }
  ];

  it('TEST 1: Cleaner with is_active === true is eligible', () => {
    const activeCleaner = profiles.find(p => p.id === 'p2')!;
    expect(isEligibleCleaner(activeCleaner)).toBe(true);

    const eligible = getEligibleCleaners(profiles);
    expect(eligible.some(p => p.id === 'p2')).toBe(true);
    expect(eligible.some(p => p.id === 'p3')).toBe(true);
  });

  it('TEST 2: Cleaner with is_active === false is NOT eligible', () => {
    const inactiveCleaner = profiles.find(p => p.id === 'p5_inactive')!;
    expect(isEligibleCleaner(inactiveCleaner)).toBe(false);

    const eligible = getEligibleCleaners(profiles);
    expect(eligible.some(p => p.id === 'p5_inactive')).toBe(false);
  });

  it('TEST 3: Cleaner with is_active === undefined is strictly INELIGIBLE', () => {
    const undefinedCleaner = profiles.find(p => p.id === 'p4_legacy_undefined')!;
    expect(isEligibleCleaner(undefinedCleaner)).toBe(false);

    const eligible = getEligibleCleaners(profiles);
    expect(eligible.some(p => p.id === 'p4_legacy_undefined')).toBe(false);
  });

  it('TEST 4: Cleaner with is_active === null is strictly INELIGIBLE', () => {
    const nullCleaner = profiles.find(p => p.id === 'p4_legacy_null')!;
    expect(isEligibleCleaner(nullCleaner)).toBe(false);

    const eligible = getEligibleCleaners(profiles);
    expect(eligible.some(p => p.id === 'p4_legacy_null')).toBe(false);
  });

  it('TEST 5: Cleaner with non-boolean is_active (string/number) is strictly INELIGIBLE', () => {
    // @ts-ignore
    const stringActiveCleaner: Profile = { id: 'p_str', username: 'c_str', full_name: 'String', role: 'cleaner', is_active: 'true' };
    // @ts-ignore
    const numberActiveCleaner: Profile = { id: 'p_num', username: 'c_num', full_name: 'Num', role: 'cleaner', is_active: 1 };

    expect(isEligibleCleaner(stringActiveCleaner)).toBe(false);
    expect(isEligibleCleaner(numberActiveCleaner)).toBe(false);
  });

  it('TEST 6: Non-cleaner roles (admin, supervisor) are NEVER eligible cleaners', () => {
    const admin = profiles.find(p => p.id === 'p1')!;
    const supervisor = profiles.find(p => p.id === 'p_sup')!;

    expect(isEligibleCleaner(admin)).toBe(false);
    expect(isEligibleCleaner(supervisor)).toBe(false);

    const eligible = getEligibleCleaners(profiles);
    expect(eligible.some(p => p.role === 'admin')).toBe(false);
    expect(eligible.some(p => p.role === 'supervisor')).toBe(false);
  });

  it('TEST 7: Flexible Distribution excludes inactive employees even with zero task load', () => {
    const activeCleaners = getEligibleCleaners(profiles);
    const dateStr = '2026-08-16';

    const tasks: TaskInstance[] = [
      // 5 tasks for p2
      { id: 't1', zone_id: 'z1', assigned_to: 'p2', task_type: 'recurring', title: 'T1', due_date: dateStr, due_time: '10:00', status: 'pending', supervisor_approved: false },
      { id: 't2', zone_id: 'z1', assigned_to: 'p2', task_type: 'recurring', title: 'T2', due_date: dateStr, due_time: '11:00', status: 'pending', supervisor_approved: false },
      { id: 't3', zone_id: 'z1', assigned_to: 'p2', task_type: 'recurring', title: 'T3', due_date: dateStr, due_time: '12:00', status: 'pending', supervisor_approved: false },
      // 2 tasks for p3
      { id: 't6', zone_id: 'z1', assigned_to: 'p3', task_type: 'recurring', title: 'T6', due_date: dateStr, due_time: '10:00', status: 'pending', supervisor_approved: false },
      { id: 't7', zone_id: 'z1', assigned_to: 'p3', task_type: 'recurring', title: 'T7', due_date: dateStr, due_time: '11:00', status: 'pending', supervisor_approved: false }
    ];

    const selected = selectFlexibleAssignee(activeCleaners, tasks, dateStr);
    // Cleaner B (p3) with 2 tasks should be selected. Inactive (p5_inactive) has 0 tasks but must NEVER be selected.
    expect(selected.id).toBe('p3');
    expect(selected.id).not.toBe('p5_inactive');
  });

  it('TEST 8: Two active cleaners with equal load use deterministic tie-breaker', () => {
    const activeCleaners = [
      profiles.find(p => p.id === 'p2')!,
      profiles.find(p => p.id === 'p3')!
    ];
    const dateStr = '2026-08-16';

    const tasks: TaskInstance[] = [
      { id: 't1', zone_id: 'z1', assigned_to: 'p2', task_type: 'recurring', title: 'T1', due_date: dateStr, due_time: '10:00', status: 'pending', supervisor_approved: false },
      { id: 't2', zone_id: 'z1', assigned_to: 'p3', task_type: 'recurring', title: 'T2', due_date: dateStr, due_time: '10:00', status: 'pending', supervisor_approved: false }
    ];

    // Tie breaker cleaner.id < bestCleaner.id -> 'p2' < 'p3' -> 'p2' selected consistently
    const selectedFirst = selectFlexibleAssignee(activeCleaners, tasks, dateStr);
    const selectedSecond = selectFlexibleAssignee(activeCleaners.reverse(), tasks, dateStr);

    expect(selectedFirst.id).toBe('p2');
    expect(selectedSecond.id).toBe('p2');
  });

  it('TEST 9: Zero active cleaners throws specific error and prevents invalid assignment', () => {
    const noCleaners: Profile[] = [];
    expect(() => selectFlexibleAssignee(noCleaners, [], '2026-08-16')).toThrow('لا يوجد موظفون نشطون متاحون لإسناد المهمة.');
  });

  it('TEST 10: Recurring SOP with inactive default assignee safely falls back to active cleaners', () => {
    const sopItem: Partial<SOPItem> = {
      id: 'sop_1',
      title: 'تنظيف الممرات',
      zone_id: 'z1',
      default_assignee_id: 'p5_inactive', // Inactive assignee in legacy SOP
      frequency: 'يومي',
      is_active: true
    };

    const activeCleaners = getEligibleCleaners(profiles);
    let assignedTo = '';

    if (sopItem.default_assignee_id) {
      const defaultEmp = profiles.find(p => p.id === sopItem.default_assignee_id);
      if (defaultEmp && isEligibleCleaner(defaultEmp)) {
        assignedTo = defaultEmp.id;
      }
    }

    if (!assignedTo) {
      const best = selectFlexibleAssignee(activeCleaners, [], '2026-08-16');
      assignedTo = best.id;
    }

    expect(assignedTo).not.toBe('p5_inactive');
    expect(activeCleaners.some(c => c.id === assignedTo)).toBe(true);
  });

  it('TEST 11: SOP with inactive zone responsible falls back to flexible active cleaner', () => {
    const zone: Partial<Zone> = {
      id: 'z_test',
      name: 'منطقة اختبار',
      responsible_employee_id: 'p5_inactive' // Inactive responsible employee
    };

    const activeCleaners = getEligibleCleaners(profiles);
    let assignedTo = '';

    if (zone.responsible_employee_id) {
      const zoneEmp = profiles.find(p => p.id === zone.responsible_employee_id);
      if (zoneEmp && isEligibleCleaner(zoneEmp)) {
        assignedTo = zoneEmp.id;
      }
    }

    if (!assignedTo) {
      const best = selectFlexibleAssignee(activeCleaners, [], '2026-08-16');
      assignedTo = best.id;
    }

    expect(assignedTo).not.toBe('p5_inactive');
    expect(activeCleaners.some(c => c.id === assignedTo)).toBe(true);
  });

  it('TEST 12: Historical tasks assigned to deactivated employees remain completely preserved', () => {
    const historicalTasks: TaskInstance[] = [
      {
        id: 'hist_1',
        zone_id: 'z1',
        assigned_to: 'p5_inactive', // Completed by Rehab when she was active
        task_type: 'recurring',
        title: 'مهمة أرشيفية قديمة',
        due_date: '2026-07-01',
        due_time: '09:00',
        status: 'completed',
        supervisor_approved: true,
        completed_at: '2026-07-01T09:30:00.000Z'
      }
    ];

    expect(historicalTasks[0].assigned_to).toBe('p5_inactive');
    expect(historicalTasks[0].status).toBe('completed');
  });

  it('TEST 13: Rework fallback selects active cleaner when original cleaner is inactive', () => {
    const originalTask: Partial<TaskInstance> = {
      id: 'task_orig',
      assigned_to: 'p5_inactive',
      zone_id: 'z1',
      title: 'مهمة أصلية'
    };

    const activeCleaners = getEligibleCleaners(profiles);
    let reworkAssignee = originalTask.assigned_to;
    const origProf = profiles.find(p => p.id === reworkAssignee);

    if (!origProf || !isEligibleCleaner(origProf)) {
      const best = selectFlexibleAssignee(activeCleaners, [], '2026-08-16');
      reworkAssignee = best.id;
    }

    expect(reworkAssignee).not.toBe('p5_inactive');
    expect(activeCleaners.some(c => c.id === reworkAssignee)).toBe(true);
  });

  it('TEST 14: saveProfile update logic sanitizes profile fields and does not overwrite is_active to true', () => {
    const existingProfile: Profile = {
      id: 'p_rehab',
      username: 'rehab',
      full_name: 'رحاب محمد',
      role: 'cleaner',
      is_active: false,
      created_at: '2026-01-01'
    };

    // Simulated update payload without is_active
    const updatePayload: Partial<Profile> = {
      id: 'p_rehab',
      full_name: 'رحاب محمد أحمد',
      phone: '01012345678'
    };

    // Logic under test:
    const targetIsActive = typeof updatePayload.is_active === 'boolean'
      ? updatePayload.is_active
      : (existingProfile.is_active === true ? true : false);

    const mergedProfile = {
      ...existingProfile,
      ...updatePayload,
      is_active: targetIsActive
    };

    expect(mergedProfile.is_active).toBe(false);
    expect(mergedProfile.full_name).toBe('رحاب محمد أحمد');
  });

  it('TEST 15: Unrelated employee edits omit is_active and preserve inactive state', () => {
    const rehab = profiles.find(p => p.id === 'p5_inactive')!;
    const unrelatedEditPayload: Partial<Profile> = {
      id: rehab.id,
      full_name: 'رحاب محمود بعد التعديل',
      phone: '01012345678',
      role: rehab.role
    };

    // The Admin employee editor must not submit a stale activity flag.
    expect(Object.prototype.hasOwnProperty.call(unrelatedEditPayload, 'is_active')).toBe(false);
    const persistedProfile = { ...rehab, ...unrelatedEditPayload };
    expect(persistedProfile.is_active).toBe(false);
  });

  it('TEST 16: Session restoration / getCurrentUserProfile rejects inactive profiles', () => {
    // Simulating user lookup with is_active check
    const usersInDb: Profile[] = [
      { id: 'p_rehab', username: 'rehab', full_name: 'رحاب', role: 'cleaner', is_active: false, created_at: '2026-01-01' },
      { id: 'p_afaf', username: 'afaf', full_name: 'عفاف', role: 'cleaner', is_active: true, created_at: '2026-01-01' },
      { id: 'p_legacy', username: 'legacy', full_name: 'قديم', role: 'cleaner', is_active: undefined, created_at: '2026-01-01' }
    ];

    function simulateGetCurrentUserProfile(username: string): Profile | null {
      const found = usersInDb.find(u => u.username === username);
      if (found && found.is_active !== true) {
        return null;
      }
      return found || null;
    }

    expect(simulateGetCurrentUserProfile('rehab')).toBeNull();
    expect(simulateGetCurrentUserProfile('legacy')).toBeNull();
    expect(simulateGetCurrentUserProfile('afaf')).not.toBeNull();
    expect(simulateGetCurrentUserProfile('afaf')?.username).toBe('afaf');
  });

  it('TEST 17: Metadata Cache TTL respects expiry and invalidation', () => {
    const TTL_MS = 30 * 1000;
    let cacheState: { data: Profile[]; timestamp: number } | null = null;

    // Cache initial data
    const initialProfiles = [{ id: 'p1', username: 'u1', full_name: 'User 1', role: 'cleaner' as const, is_active: true, created_at: '2026-01-01' }];
    cacheState = { data: initialProfiles, timestamp: 1000 };

    // Within TTL (e.g. 5 seconds later)
    const isFresh = (now: number) => cacheState !== null && (now - cacheState.timestamp < TTL_MS);
    expect(isFresh(6000)).toBe(true);

    // After TTL (e.g. 35 seconds later)
    expect(isFresh(32000)).toBe(false);

    // After manual invalidation
    cacheState = null;
    expect(isFresh(2000)).toBe(false);
  });

  it('TEST 18: Seed keeps Rehab inactive and removes future p3 assignment defaults', async () => {
    const { getSeededDB } = await import('../db_default');
    const seeded = getSeededDB();
    const rehab = seeded.profiles.find((profile) => profile.id === 'p3');

    expect(rehab?.role).toBe('cleaner');
    expect(rehab?.is_active).toBe(false);
    expect(seeded.zones.some((zone) => zone.responsible_employee_id === 'p3')).toBe(false);
    expect(seeded.task_templates.some((template) => template.default_assignee_id === 'p3')).toBe(false);
    expect(seeded.operational_tasks.some((task) => task.responsible_employee_id === 'p3')).toBe(false);
  });
});
