PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 4000),
  start_date TEXT NOT NULL CHECK(start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date TEXT NOT NULL CHECK(end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND end_date >= start_date),
  priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
  success_criteria TEXT NOT NULL CHECK(length(success_criteria) BETWEEN 1 AND 2000),
  expected_minutes INTEGER NOT NULL CHECK(expected_minutes BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL CHECK(version >= 1), source_review_id TEXT UNIQUE REFERENCES reviews(id),
  carried_improvement TEXT NOT NULL DEFAULT '' CHECK(length(carried_improvement) <= 2000),
  record_origin TEXT NOT NULL CHECK(record_origin IN ('user','synthetic')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS plan_history (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  created_at TEXT NOT NULL, UNIQUE(plan_id,version)
) STRICT;
CREATE TRIGGER IF NOT EXISTS plan_history_no_update BEFORE UPDATE ON plan_history
BEGIN SELECT RAISE(ABORT,'immutable_history'); END;
CREATE TRIGGER IF NOT EXISTS plan_history_no_delete BEFORE DELETE ON plan_history
BEGIN SELECT RAISE(ABORT,'immutable_history'); END;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160), notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 4000),
  due_date TEXT CHECK(due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json) AND json_type(tags_json) = 'array' AND json_array_length(tags_json) <= 20),
  expected_minutes INTEGER NOT NULL CHECK(expected_minutes BETWEEN 0 AND 1000000),
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  completion_cycle INTEGER NOT NULL DEFAULT 0 CHECK(completion_cycle >= 0),
  version INTEGER NOT NULL CHECK(version >= 1), deleted_at TEXT,
  record_origin TEXT NOT NULL CHECK(record_origin IN ('user','synthetic')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS tasks_plan ON tasks(plan_id);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL CHECK(ended_at >= started_at),
  actual_minutes INTEGER NOT NULL CHECK(actual_minutes BETWEEN 0 AND 1000000),
  blocked_reason TEXT NOT NULL DEFAULT '' CHECK(length(blocked_reason) <= 4000),
  record_origin TEXT NOT NULL CHECK(record_origin IN ('user','synthetic')), created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id);
CREATE TABLE IF NOT EXISTS completion_events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), cycle INTEGER NOT NULL CHECK(cycle >= 0),
  request_id TEXT NOT NULL UNIQUE, completed_at TEXT NOT NULL, UNIQUE(task_id,cycle)
) STRICT;
CREATE TABLE IF NOT EXISTS request_receipts (
  request_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('task.complete','task.reopen')),
  resource_id TEXT NOT NULL REFERENCES tasks(id), response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json) = 'object'),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
  improvement TEXT NOT NULL CHECK(length(trim(improvement)) BETWEEN 1 AND 2000),
  next_plan_id TEXT UNIQUE REFERENCES plans(id),
  record_origin TEXT NOT NULL CHECK(record_origin IN ('user','synthetic')), created_at TEXT NOT NULL
) STRICT;
