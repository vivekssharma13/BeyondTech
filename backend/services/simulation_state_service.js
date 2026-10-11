const { getDatabase, transaction, json } = require('./database_service');

const MUTABLE_OPERATIONAL_FIELDS = Object.freeze([
  'currentImportMW',
  'currentExportMW',
  'batterySocPct',
  'batteryPowerMW',
  'revenueToday',
  'reservePct',
  'batteryMode',
  'gridExportLimitMW',
  'gridImportLimitMW',
  'outputLimitPct',
  'operatingMode',
]);

function operationalStateFromFarm(farm) {
  return Object.fromEntries(MUTABLE_OPERATIONAL_FIELDS.map(field => [field, farm[field]]));
}

function parseState(row) {
  return {
    farmId: row.farm_id,
    stateVersion: Number(row.state_version),
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: JSON.parse(row.state_json),
  };
}

function initializeAndRecoverFarmState(farms) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT OR IGNORE INTO simulated_farm_state
    (farm_id, state_version, state_json, source_type, source_ref, created_at, updated_at)
    VALUES (?, 1, ?, 'USER_CONFIGURED_SIMULATION', 'backend/api_dashboard_data.js', ?, ?)`);
  for (const farm of farms) insert.run(farm.farmId, json(operationalStateFromFarm(farm)), now, now);

  const rows = db.prepare('SELECT * FROM simulated_farm_state').all();
  const byFarm = new Map(rows.map(row => [row.farm_id, parseState(row)]));
  for (const farm of farms) {
    const persisted = byFarm.get(farm.farmId);
    if (persisted) Object.assign(farm, persisted.state);
  }
  return farms;
}

function getPersistedFarmState(farmId, db = getDatabase()) {
  const row = db.prepare('SELECT * FROM simulated_farm_state WHERE farm_id=?').get(farmId);
  return row ? parseState(row) : null;
}

function persistOperationalState(farm, changes) {
  return transaction(db => {
    const persisted = getPersistedFarmState(farm.farmId, db);
    if (!persisted) throw new Error(`Persisted operational state is missing for farm ${farm.farmId}`);
    const nextState = { ...persisted.state, ...changes };
    const updatedAt = new Date().toISOString();
    const nextVersion = persisted.stateVersion + 1;
    const result = db.prepare(`UPDATE simulated_farm_state
      SET state_version=?, state_json=?, updated_at=?
      WHERE farm_id=? AND state_version=?`)
      .run(nextVersion, json(nextState), updatedAt, farm.farmId, persisted.stateVersion);
    if (result.changes !== 1) {
      const error = new Error(`Operational state changed concurrently for farm ${farm.farmId}`);
      error.code = 'STATE_VERSION_CONFLICT';
      throw error;
    }
    return { farmId: farm.farmId, stateVersion: nextVersion, state: nextState, updatedAt };
  });
}

function resetFarmStateForTests(farms) {
  const db = getDatabase();
  db.prepare('DELETE FROM simulated_farm_state').run();
  initializeAndRecoverFarmState(farms);
}

module.exports = {
  MUTABLE_OPERATIONAL_FIELDS,
  operationalStateFromFarm,
  initializeAndRecoverFarmState,
  getPersistedFarmState,
  persistOperationalState,
  resetFarmStateForTests,
};

