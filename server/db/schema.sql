-- Naris Ops PostgreSQL foundation.
-- Firestore document IDs and legacy references are kept as text.
-- raw_data preserves source fields; user password records are kept separately.

CREATE TABLE IF NOT EXISTS firestore_documents (
  collection_name TEXT NOT NULL,
  document_path TEXT NOT NULL,
  document_id TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_create_time TIMESTAMPTZ,
  source_update_time TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_name, document_path)
);

CREATE INDEX IF NOT EXISTS firestore_documents_collection_idx
  ON firestore_documents (collection_name, document_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'cleaner')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  password_record TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_record TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_uq
  ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  location_id TEXT,
  name TEXT NOT NULL,
  responsible_employee_id TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS zones_responsible_employee_idx
  ON zones (responsible_employee_id);

CREATE TABLE IF NOT EXISTS sop_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  task_code TEXT,
  zone_id TEXT NOT NULL,
  frequency TEXT NOT NULL,
  recurrence_days JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduled_time TEXT,
  scheduled_times JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_assignee_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sop_items_active_idx
  ON sop_items (is_active, zone_id);

CREATE TABLE IF NOT EXISTS task_instances (
  id TEXT PRIMARY KEY,
  template_id TEXT,
  sop_item_id TEXT,
  zone_id TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  assigned_by TEXT,
  task_type TEXT NOT NULL,
  parent_instance_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE NOT NULL,
  due_time TEXT,
  status TEXT NOT NULL,
  occurrence_index INTEGER,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS task_instances_due_date_idx
  ON task_instances (due_date);

CREATE INDEX IF NOT EXISTS task_instances_assignee_due_date_idx
  ON task_instances (assigned_to, due_date);
CREATE INDEX IF NOT EXISTS task_instances_due_status_idx ON task_instances (due_date, status);
CREATE INDEX IF NOT EXISTS task_instances_parent_idx ON task_instances (parent_instance_id) WHERE parent_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_instances_sop_due_date_idx
  ON task_instances (sop_item_id, due_date);

-- Protect recurring occurrences from duplicate inserts, including concurrent runs.
CREATE UNIQUE INDEX IF NOT EXISTS task_instances_recurring_occurrence_uq
  ON task_instances (template_id, due_date, occurrence_index)
  WHERE task_type = 'recurring' AND occurrence_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_generation_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  generated_count INTEGER NOT NULL DEFAULT 0,
  skipped_existing_count INTEGER NOT NULL DEFAULT 0,
  skipped_no_assignee_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS task_generation_runs_date_idx
  ON task_generation_runs (run_date, started_at DESC);


-- Server-managed, revocable browser sessions. Only token hashes are stored.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at);

-- Additional normalized operational entities. Original source JSON remains preserved.
CREATE TABLE IF NOT EXISTS operational_tasks (
  id TEXT PRIMARY KEY,
  zone_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  responsible_employee_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS operational_tasks_zone_idx ON operational_tasks (zone_id);

CREATE TABLE IF NOT EXISTS device_switches (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  zone_id TEXT,
  panel_location TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS device_switches_zone_idx ON device_switches (zone_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('معدات تنظيف', 'مواد كيميائية', 'مستهلكات', 'أخرى')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  min_quantity INTEGER NOT NULL CHECK (min_quantity >= 0),
  status TEXT NOT NULL CHECK (status IN ('متوفر', 'منخفض', 'نفد')),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS inventory_items_category_name_idx ON inventory_items (category, name);

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id TEXT PRIMARY KEY,
  profile_id TEXT,
  period_type TEXT,
  period_start DATE,
  period_end DATE,
  tasks_assigned INTEGER,
  tasks_completed_on_time INTEGER,
  tasks_late INTEGER,
  tasks_reworked INTEGER,
  compliance_rate NUMERIC,
  avg_execution_time_minutes NUMERIC,
  quality_score NUMERIC,
  supervisor_rating NUMERIC,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kpi_snapshots_profile_period_idx
  ON kpi_snapshots (profile_id, period_start, period_end);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS audit_logs_task_created_idx
  ON audit_logs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);


-- Distinct operational template collection; do not alias it to recurring SOP schedules.
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  task_code TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS task_templates_zone_active_idx
  ON task_templates (zone_id, is_active);
CREATE INDEX IF NOT EXISTS task_templates_code_idx
  ON task_templates (task_code);


-- Relational metadata for media objects stored outside PostgreSQL (Cloudinary).
CREATE TABLE IF NOT EXISTS task_media (
  task_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('before', 'after')),
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('cloudinary', 'legacy_external')),
  public_id TEXT,
  secure_url TEXT NOT NULL,
  mime_type TEXT,
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size >= 0),
  captured_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, side)
);
CREATE INDEX IF NOT EXISTS task_media_public_id_idx
  ON task_media (public_id) WHERE public_id IS NOT NULL;
