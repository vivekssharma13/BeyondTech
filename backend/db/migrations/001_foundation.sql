PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,
  status TEXT NOT NULL,
  farm_id TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  request_metadata_json TEXT NOT NULL DEFAULT '{}',
  result_summary_json TEXT,
  error_json TEXT
);

CREATE TABLE IF NOT EXISTS component_executions (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  component TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT,
  model_name TEXT,
  model_version TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  input_summary_json TEXT NOT NULL DEFAULT '{}',
  output_summary_json TEXT,
  error_json TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  event_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  run_id TEXT,
  component TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id),
  FOREIGN KEY (run_id) REFERENCES component_executions(run_id)
);

CREATE TABLE IF NOT EXISTS optimizer_scenarios (
  scenario_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  run_id TEXT,
  farm_id TEXT,
  status TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  input_summary_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS decision_proposals (
  decision_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  run_id TEXT,
  farm_id TEXT NOT NULL,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  quantity_mw REAL NOT NULL,
  source_type TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS decision_events (
  decision_event_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id)
);

CREATE TABLE IF NOT EXISTS planned_energy_allocations (
  allocation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  action TEXT NOT NULL,
  power_mw REAL NOT NULL,
  interval_start TEXT,
  interval_end TEXT,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id)
);

CREATE TABLE IF NOT EXISTS applied_simulated_allocations (
  applied_allocation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  action TEXT NOT NULL,
  power_mw REAL NOT NULL,
  state_before_json TEXT NOT NULL,
  state_after_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id)
);

CREATE TABLE IF NOT EXISTS financial_ledger (
  ledger_entry_id TEXT PRIMARY KEY,
  decision_id TEXT,
  farm_id TEXT,
  entry_type TEXT NOT NULL,
  amount_minor_units INTEGER,
  currency TEXT,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  calculation_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id)
);

CREATE TABLE IF NOT EXISTS simulation_config_versions (
  config_version INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  supersedes_version INTEGER,
  FOREIGN KEY (supersedes_version) REFERENCES simulation_config_versions(config_version)
);

CREATE INDEX IF NOT EXISTS idx_workflows_started_at ON workflows(started_at);
CREATE INDEX IF NOT EXISTS idx_components_workflow ON component_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_events_workflow_timestamp ON workflow_events(workflow_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_decisions_workflow ON decision_proposals(workflow_id);

