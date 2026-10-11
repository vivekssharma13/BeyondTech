CREATE TABLE IF NOT EXISTS simulated_farm_state (
  farm_id TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_simulated_farm_state_updated_at
  ON simulated_farm_state(updated_at);

