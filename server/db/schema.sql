-- Naris Ops PostgreSQL foundation.
-- Firestore document IDs and legacy references are kept as text.
-- raw_data preserves original source fields during staged migration.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'cleaner')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci_uq
  ON users (LOWER(username));

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
