PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_definitions (
  market_definition_id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version > 0),
  display_name TEXT NOT NULL,
  market_type TEXT NOT NULL,
  reference_pricing_zone TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_unit TEXT NOT NULL,
  native_interval_minutes INTEGER NOT NULL CHECK (native_interval_minutes > 0),
  market_timezone TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK (source_mode IN ('HISTORICAL_DATA', 'DEMO_SIMULATION', 'UNAVAILABLE')),
  data_provenance_json TEXT NOT NULL,
  congestion_limitations TEXT NOT NULL,
  configuration_version INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (market_id, definition_version)
);

CREATE TABLE IF NOT EXISTS imported_market_datasets (
  dataset_id TEXT PRIMARY KEY,
  market_definition_id TEXT NOT NULL,
  exchange_name TEXT NOT NULL,
  market_product TEXT NOT NULL,
  pricing_area TEXT NOT NULL,
  declared_currency TEXT NOT NULL,
  declared_price_unit TEXT NOT NULL,
  original_timezone TEXT NOT NULL,
  original_source TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  stored_source_path TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  manifest_checksum_sha256 TEXT NOT NULL,
  publication_timestamp TEXT,
  retrieval_timestamp TEXT NOT NULL,
  import_timestamp TEXT NOT NULL,
  expected_delivery_start_utc TEXT NOT NULL,
  expected_delivery_end_utc TEXT NOT NULL,
  revision_identifier TEXT,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  data_quality_status TEXT NOT NULL,
  configuration_version INTEGER,
  status TEXT NOT NULL,
  CHECK (expected_delivery_end_utc > expected_delivery_start_utc),
  FOREIGN KEY (market_definition_id) REFERENCES market_definitions(market_definition_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_imported_market_dataset_content
  ON imported_market_datasets(market_definition_id, checksum_sha256, COALESCE(revision_identifier, ''));

CREATE TABLE IF NOT EXISTS market_observations (
  observation_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
  original_delivery_start TEXT NOT NULL,
  original_delivery_end TEXT NOT NULL,
  original_timezone TEXT NOT NULL,
  original_price_text TEXT NOT NULL,
  original_price_unit TEXT NOT NULL,
  delivery_start_utc TEXT NOT NULL,
  delivery_end_utc TEXT NOT NULL,
  price_paise_per_mwh INTEGER NOT NULL,
  publication_timestamp TEXT,
  revision_identifier TEXT,
  data_quality_status TEXT NOT NULL,
  raw_record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES imported_market_datasets(dataset_id),
  UNIQUE (dataset_id, source_row_number)
);

CREATE TABLE IF NOT EXISTS synthetic_market_scenario_definitions (
  scenario_id TEXT NOT NULL,
  scenario_version INTEGER NOT NULL CHECK (scenario_version > 0),
  market_definition_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  configuration_version INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (scenario_id, scenario_version),
  FOREIGN KEY (market_definition_id) REFERENCES market_definitions(market_definition_id)
);

CREATE TABLE IF NOT EXISTS market_price_intervals (
  price_interval_id TEXT PRIMARY KEY,
  market_definition_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  dataset_id TEXT,
  scenario_id TEXT,
  scenario_version INTEGER,
  forecast_run_id TEXT,
  observation_id TEXT,
  market_product TEXT NOT NULL,
  pricing_area TEXT NOT NULL,
  delivery_start_utc TEXT NOT NULL,
  delivery_end_utc TEXT NOT NULL,
  price_paise_per_mwh INTEGER NOT NULL,
  currency TEXT NOT NULL,
  price_unit TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'OBSERVED_MARKET_PRICE',
    'NUMERICAL_MODEL_FORECAST',
    'DETERMINISTIC_MARKET_SIMULATION',
    'LLM_SCENARIO_ESTIMATE_LEGACY',
    'UNAVAILABLE'
  )),
  original_source TEXT NOT NULL,
  retrieval_timestamp TEXT NOT NULL,
  publication_timestamp TEXT,
  revision_identifier TEXT,
  data_quality_status TEXT NOT NULL,
  configuration_version INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (market_definition_id) REFERENCES market_definitions(market_definition_id),
  FOREIGN KEY (dataset_id) REFERENCES imported_market_datasets(dataset_id),
  FOREIGN KEY (observation_id) REFERENCES market_observations(observation_id),
  FOREIGN KEY (scenario_id, scenario_version) REFERENCES synthetic_market_scenario_definitions(scenario_id, scenario_version),
  FOREIGN KEY (forecast_run_id) REFERENCES market_model_forecast_runs(forecast_run_id),
  CHECK (delivery_end_utc > delivery_start_utc),
  CHECK (dataset_id IS NOT NULL OR scenario_id IS NOT NULL OR forecast_run_id IS NOT NULL OR source_type = 'UNAVAILABLE')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_market_price_interval_identity
  ON market_price_intervals(
    market_id,
    market_product,
    pricing_area,
    delivery_start_utc,
    delivery_end_utc,
    original_source,
    COALESCE(revision_identifier, '')
  );

CREATE TABLE IF NOT EXISTS market_model_forecast_runs (
  forecast_run_id TEXT PRIMARY KEY,
  market_definition_id TEXT NOT NULL,
  dataset_id TEXT,
  status TEXT NOT NULL,
  model_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  training_data_cutoff TEXT,
  forecast_generated_at TEXT NOT NULL,
  native_interval_minutes INTEGER NOT NULL,
  forecast_horizon_intervals INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  metrics_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (market_definition_id) REFERENCES market_definitions(market_definition_id),
  FOREIGN KEY (dataset_id) REFERENCES imported_market_datasets(dataset_id)
);

CREATE TABLE IF NOT EXISTS market_intelligence_runs (
  intelligence_run_id TEXT PRIMARY KEY,
  market_definition_id TEXT NOT NULL,
  forecast_run_id TEXT,
  workflow_id TEXT,
  status TEXT NOT NULL,
  provider TEXT,
  model_name TEXT,
  source_type TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  input_references_json TEXT NOT NULL DEFAULT '[]',
  output_json TEXT,
  error_json TEXT,
  FOREIGN KEY (market_definition_id) REFERENCES market_definitions(market_definition_id),
  FOREIGN KEY (forecast_run_id) REFERENCES market_model_forecast_runs(forecast_run_id),
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

CREATE TABLE IF NOT EXISTS market_data_quality_results (
  quality_result_id TEXT PRIMARY KEY,
  dataset_id TEXT,
  forecast_run_id TEXT,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  affected_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id) REFERENCES imported_market_datasets(dataset_id),
  FOREIGN KEY (forecast_run_id) REFERENCES market_model_forecast_runs(forecast_run_id),
  CHECK (dataset_id IS NOT NULL OR forecast_run_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_market_intervals_delivery
  ON market_price_intervals(market_id, market_product, pricing_area, delivery_start_utc);
CREATE INDEX IF NOT EXISTS idx_market_observations_dataset
  ON market_observations(dataset_id, delivery_start_utc);
CREATE INDEX IF NOT EXISTS idx_market_quality_dataset
  ON market_data_quality_results(dataset_id, checked_at);
