PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_simulation_runs (
  simulation_run_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  market_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version INTEGER NOT NULL,
  configuration_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  planning_start_utc TEXT NOT NULL,
  planning_end_utc TEXT NOT NULL,
  interval_count INTEGER NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS portfolio_optimizer_runs (
  optimizer_run_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  scenario_id TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  solver_name TEXT NOT NULL,
  solver_status TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,
  input_snapshot_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  validation_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS portfolio_plan_allocations (
  allocation_id TEXT PRIMARY KEY,
  optimizer_run_id TEXT NOT NULL,
  decision_id TEXT,
  farm_id TEXT NOT NULL,
  hour_index INTEGER NOT NULL CHECK (hour_index BETWEEN 0 AND 71),
  interval_start_utc TEXT NOT NULL,
  interval_end_utc TEXT NOT NULL,
  generation_mwh REAL NOT NULL,
  direct_export_mwh REAL NOT NULL,
  battery_charge_mwh REAL NOT NULL,
  battery_discharge_mwh REAL NOT NULL,
  grid_import_mwh REAL NOT NULL,
  curtailment_mwh REAL NOT NULL,
  soc_start_mwh REAL NOT NULL,
  soc_end_mwh REAL NOT NULL,
  price_inr_per_mwh REAL NOT NULL,
  projected_net_value_inr REAL NOT NULL,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (optimizer_run_id) REFERENCES portfolio_optimizer_runs(optimizer_run_id),
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id),
  UNIQUE (optimizer_run_id, farm_id, hour_index)
);

CREATE TABLE IF NOT EXISTS applied_portfolio_allocations (
  applied_allocation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  optimizer_run_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  interval_start_utc TEXT NOT NULL,
  interval_end_utc TEXT NOT NULL,
  allocation_json TEXT NOT NULL,
  state_before_json TEXT NOT NULL,
  state_after_json TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id),
  FOREIGN KEY (optimizer_run_id) REFERENCES portfolio_optimizer_runs(optimizer_run_id),
  UNIQUE (decision_id, farm_id)
);

CREATE TABLE IF NOT EXISTS simulated_financial_ledger (
  ledger_entry_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  optimizer_run_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  delivery_start_utc TEXT NOT NULL,
  delivery_end_utc TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  exported_energy_mwh REAL NOT NULL,
  imported_energy_mwh REAL NOT NULL,
  battery_throughput_mwh REAL NOT NULL,
  price_inr_per_mwh REAL NOT NULL,
  gross_sale_revenue_inr REAL NOT NULL,
  purchase_cost_inr REAL NOT NULL,
  transaction_fees_inr REAL NOT NULL,
  degradation_cost_inr REAL NOT NULL,
  export_tariff_cost_inr REAL NOT NULL,
  import_tariff_cost_inr REAL NOT NULL,
  net_value_inr REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency = 'INR'),
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,
  calculation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_id) REFERENCES decision_proposals(decision_id),
  FOREIGN KEY (optimizer_run_id) REFERENCES portfolio_optimizer_runs(optimizer_run_id),
  UNIQUE (decision_id, farm_id)
);

CREATE INDEX IF NOT EXISTS idx_market_simulation_runs_created
  ON market_simulation_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_optimizer_runs_created
  ON portfolio_optimizer_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_allocations_decision
  ON portfolio_plan_allocations(decision_id, hour_index, farm_id);
CREATE INDEX IF NOT EXISTS idx_simulated_ledger_created
  ON simulated_financial_ledger(created_at DESC, farm_id);
