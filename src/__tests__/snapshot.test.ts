import { describe, it, expect } from 'vitest';
import { buildTaskInstanceSnapshot } from '../lib/task-utils';
import { SOPItem } from '../types';

describe('Task Instance Snapshot & Single SOP Image Flow', () => {
  const sampleSop: SOPItem = {
    id: 'sop_test_01',
    zone_id: 'z_reception',
    task_code: 'SOP_CLE01',
    title: 'تنظيف وتطهير مدخل الاستقبال والمكاتب',
    description: 'استخدام المطهر المعتمد ومسح الأسطح بالكامل',
    goal: 'بيئة نظيفة وواجهة مشرفة للشركة',
    category: 'نظافة',
    tools_required: 'ممسحة مايكروفايبر + مطهر أرضيات',
    frequency: 'يومي',
    estimated_duration_minutes: 25,
    scheduled_time: '08:00',
    requires_photo_before: true,
    requires_photo_after: true,
    requires_supervisor_approval: true,
    requires_gps: false,
    is_reopenable: false,
    auto_escalate_if_late: false,
    default_assignee_id: 'p2',
    is_active: true,
    reference_image_url: 'https://res.cloudinary.com/demo/image/upload/v12345/reception_sop.jpg'
  };

  it('builds a complete isolated TaskInstance snapshot from SOPItem', () => {
    const snapshot = buildTaskInstanceSnapshot(
      sampleSop,
      '2026-08-16',
      { time: '08:00', occurrenceIndex: 0 },
      'p2'
    );

    expect(snapshot.id).toBe('ti_rec_sop_test_01_2026-08-16_0');
    expect(snapshot.sop_item_id).toBe('sop_test_01');
    expect(snapshot.template_id).toBe('sop_test_01');
    expect(snapshot.zone_id).toBe('z_reception');
    expect(snapshot.assigned_to).toBe('p2');
    expect(snapshot.task_type).toBe('recurring');
    expect(snapshot.due_date).toBe('2026-08-16');
    expect(snapshot.due_time).toBe('08:00');
    expect(snapshot.status).toBe('pending');
    expect(snapshot.supervisor_approved).toBe(false);
    expect(snapshot.requires_photo_before).toBe(true);
    expect(snapshot.requires_photo_after).toBe(true);
    expect(snapshot.requires_supervisor_approval).toBe(true);
  });

  it('preserves single reference_image_url as the official SOP reference', () => {
    const snapshot = buildTaskInstanceSnapshot(
      sampleSop,
      '2026-08-16',
      { time: '08:00', occurrenceIndex: 0 },
      'p2'
    );

    expect(snapshot.reference_image_url).toBe(
      'https://res.cloudinary.com/demo/image/upload/v12345/reception_sop.jpg'
    );
  });

  it('guarantees snapshot isolation from template mutation', () => {
    const mutableSop: SOPItem = { ...sampleSop };
    const snapshot = buildTaskInstanceSnapshot(
      mutableSop,
      '2026-08-16',
      { time: '08:00', occurrenceIndex: 0 },
      'p2'
    );

    // Mutate the original template
    mutableSop.title = 'عنوان جديد بعد التعديل';
    mutableSop.estimated_duration_minutes = 99;
    mutableSop.reference_image_url = 'https://res.cloudinary.com/demo/image/upload/v999/new_sop.jpg';

    // Verify snapshot values remain immutable
    expect(snapshot.title).toBe('تنظيف وتطهير مدخل الاستقبال والمكاتب');
    expect(snapshot.estimated_duration_minutes).toBe(25);
    expect(snapshot.reference_image_url).toBe(
      'https://res.cloudinary.com/demo/image/upload/v12345/reception_sop.jpg'
    );
  });
});
