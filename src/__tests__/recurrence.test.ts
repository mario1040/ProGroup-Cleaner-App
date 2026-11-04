import { describe, it, expect } from 'vitest';
import { getArabicDayName, getDaysDiff, getSopOccurrencesForDate, generateTaskInstanceId } from '../lib/task-utils';
import { SOPItem } from '../types';

describe('Recurrence Engine & Arabic Day Mapping', () => {
  it('correctly maps dates to Arabic day names', () => {
    // 2026-08-16 is Sunday -> الأحد
    expect(getArabicDayName('2026-08-16')).toBe('الأحد');
    // 2026-08-17 is Monday -> الاثنين
    expect(getArabicDayName('2026-08-17')).toBe('الاثنين');
    // 2026-08-18 is Tuesday -> الثلاثاء
    expect(getArabicDayName('2026-08-18')).toBe('الثلاثاء');
    // 2026-08-19 is Wednesday -> الأربعاء
    expect(getArabicDayName('2026-08-19')).toBe('الأربعاء');
    // 2026-08-20 is Thursday -> الخميس
    expect(getArabicDayName('2026-08-20')).toBe('الخميس');
    // 2026-08-21 is Friday -> الجمعة
    expect(getArabicDayName('2026-08-21')).toBe('الجمعة');
    // 2026-08-22 is Saturday -> السبت
    expect(getArabicDayName('2026-08-22')).toBe('السبت');
  });

  it('calculates calendar day differences accurately', () => {
    expect(getDaysDiff('2026-08-01', '2026-08-01')).toBe(0);
    expect(getDaysDiff('2026-08-01', '2026-08-03')).toBe(2);
    expect(getDaysDiff('2026-08-01', '2026-08-31')).toBe(30);
  });

  it('generates daily occurrences for active daily SOP items', () => {
    const dailySop: SOPItem = {
      id: 'sop_daily_1',
      zone_id: 'z_reception',
      task_code: 'SOP_CLE01',
      title: 'تنظيف وتطهير أرضيات الاستقبال',
      category: 'نظافة',
      frequency: 'يومي',
      scheduled_time: '08:30',
      requires_photo_before: true,
      requires_photo_after: true,
      requires_supervisor_approval: true,
      requires_gps: false,
      is_reopenable: false,
      auto_escalate_if_late: false,
      is_active: true,
      reference_image_url: 'https://res.cloudinary.com/test/ref.jpg'
    };

    const occurrences = getSopOccurrencesForDate(dailySop, '2026-08-16');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].time).toBe('08:30');
    expect(occurrences[0].occurrenceIndex).toBe(0);
  });

  it('generates multi-occurrence daily tasks when scheduled_times are defined', () => {
    const multiDailySop: SOPItem = {
      id: 'sop_multi_1',
      zone_id: 'z_bathrooms',
      task_code: 'SOP_CLE02',
      title: 'دورة تطهير وتعطير دورات المياه',
      category: 'نظافة',
      frequency: 'يومي',
      scheduled_times: ['09:00', '13:00', '17:00'],
      requires_photo_before: true,
      requires_photo_after: true,
      requires_supervisor_approval: true,
      requires_gps: false,
      is_reopenable: false,
      auto_escalate_if_late: false,
      is_active: true
    };

    const occurrences = getSopOccurrencesForDate(multiDailySop, '2026-08-16');
    expect(occurrences).toHaveLength(3);
    expect(occurrences[0].time).toBe('09:00');
    expect(occurrences[1].time).toBe('13:00');
    expect(occurrences[2].time).toBe('17:00');
  });

  it('respects weekly recurrence_days', () => {
    const weeklySop: SOPItem = {
      id: 'sop_weekly_1',
      zone_id: 'z_facades',
      task_code: 'SOP_CLE03',
      title: 'تلميع الواجهات والزجاج الخارجي',
      category: 'نظافة',
      frequency: 'أسبوعي',
      recurrence_days: ['الأحد', 'الخميس'],
      scheduled_time: '11:00',
      requires_photo_before: true,
      requires_photo_after: true,
      requires_supervisor_approval: true,
      requires_gps: false,
      is_reopenable: false,
      auto_escalate_if_late: false,
      is_active: true
    };

    // Sunday matches
    const sundayOccurrences = getSopOccurrencesForDate(weeklySop, '2026-08-16');
    expect(sundayOccurrences).toHaveLength(1);
    expect(sundayOccurrences[0].time).toBe('11:00');

    // Monday does not match
    const mondayOccurrences = getSopOccurrencesForDate(weeklySop, '2026-08-17');
    expect(mondayOccurrences).toHaveLength(0);

    // Thursday matches
    const thursdayOccurrences = getSopOccurrencesForDate(weeklySop, '2026-08-20');
    expect(thursdayOccurrences).toHaveLength(1);
  });

  it('returns empty occurrences for inactive SOPs', () => {
    const inactiveSop: SOPItem = {
      id: 'sop_inactive_1',
      zone_id: 'z_reception',
      task_code: 'SOP_CLE04',
      title: 'مهمة معطلة',
      category: 'نظافة',
      frequency: 'يومي',
      is_active: false,
      requires_photo_before: true,
      requires_photo_after: true,
      requires_supervisor_approval: true,
      requires_gps: false,
      is_reopenable: false,
      auto_escalate_if_late: false
    };

    expect(getSopOccurrencesForDate(inactiveSop, '2026-08-16')).toHaveLength(0);
  });

  it('generates predictable deterministic TaskInstance IDs', () => {
    const id = generateTaskInstanceId('sop_123', '2026-08-16', 0);
    expect(id).toBe('ti_rec_sop_123_2026-08-16_0');
  });
});
