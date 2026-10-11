const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getDatabase, closeDatabase } = require('../services/database_service');
const { initialConfiguration, validateConfiguration, getActiveConfiguration, createConfigurationVersion, missingEconomicAssumptions } = require('../services/configuration_service');
const { startWorkflow, completeWorkflow, getWorkflowDetails, sanitize } = require('../services/workflow_service');
const { createBucketCache } = require('../services/cache_service');
const { runJsonProcess } = require('../services/subprocess_service');
const { createGenerationService } = require('../services/generation_service');
const { farms } = require('../api_dashboard_data');
const phase2aProfile = require('../config/examples/phase2a_demo_profile');
const { initializeAndRecoverFarmState, getPersistedFarmState } = require('../services/simulation_state_service');
const { saveDecisionProposal, persistDecisionAction } = require('../services/audit_repository');

test.afterEach(() => {
  closeDatabase();
  process.env.ENERGY_DB_PATH = ':memory:';
});

test('SQLite migrations and configuration survive database reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-phase1-'));
  const databasePath = path.join(directory, 'audit.sqlite');
  process.env.ENERGY_DB_PATH = databasePath;

  const first = getActiveConfiguration();
  assert.equal(first.configVersion, 1);
  closeDatabase();

  const second = getActiveConfiguration();
  assert.equal(second.configVersion, 1);
  assert.equal(second.configuration.battery.chargingEfficiency.value, 0.92);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 4);
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('accepted decision state and audit records survive restart without duplicate application', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'energy-state-'));
  process.env.ENERGY_DB_PATH = path.join(directory, 'state.sqlite');
  const originalFarm = structuredClone(farms[0]);
  const firstProcessFarm = structuredClone(originalFarm);
  initializeAndRecoverFarmState([firstProcessFarm]);
  const decision = {
    decisionId: 'decision-restart-test',
    workflowId: null,
    agentRunId: 'decision-run-restart-test',
    farmId: firstProcessFarm.farmId,
    executionStatus: 'PENDING',
    decision: 'BUY',
    quantityMW: 5,
    marketPricePerMWh: 5000,
    generatedAt: new Date().toISOString(),
    sourceType: 'USER_CONFIGURED_SIMULATION',
  };
  saveDecisionProposal(decision);
  const applied = persistDecisionAction({ decision, action: 'ACCEPT', farm: firstProcessFarm, chargingEfficiency: 0.92, dischargingEfficiency: 0.92 });
  assert.equal(applied.status, 'APPLIED');
  assert.notDeepEqual(applied.after, applied.before);
  closeDatabase();

  const restartedFarm = structuredClone(originalFarm);
  initializeAndRecoverFarmState([restartedFarm]);
  assert.deepEqual(restartedFarm.currentImportMW, applied.after.currentImportMW);
  assert.deepEqual(restartedFarm.batterySocPct, applied.after.batterySocPct);
  assert.equal(getPersistedFarmState(restartedFarm.farmId).stateVersion, applied.stateVersion);
  assert.throws(
    () => persistDecisionAction({ decision, action: 'ACCEPT', farm: restartedFarm, chargingEfficiency: 0.92, dischargingEfficiency: 0.92 }),
    error => error.code === 'DECISION_ALREADY_APPLIED',
  );
  const db = getDatabase();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM applied_simulated_allocations WHERE decision_id=?').get(decision.decisionId).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM financial_ledger WHERE decision_id=?').get(decision.decisionId).count, 1);
  assert.equal(getPersistedFarmState(restartedFarm.farmId).stateVersion, applied.stateVersion);
  closeDatabase();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('decision state, approval, allocation, and ledger roll back as one unit', () => {
  const farm = structuredClone(farms[0]);
  initializeAndRecoverFarmState([farm]);
  const decision = {
    decisionId: 'decision-atomicity-test',
    workflowId: null,
    agentRunId: 'decision-run-atomicity-test',
    farmId: farm.farmId,
    executionStatus: 'PENDING',
    decision: 'SELL',
    quantityMW: 5,
    marketPricePerMWh: 9000,
    generatedAt: new Date().toISOString(),
    sourceType: 'USER_CONFIGURED_SIMULATION',
  };
  saveDecisionProposal(decision);
  const db = getDatabase();
  const before = getPersistedFarmState(farm.farmId);
  db.exec(`CREATE TRIGGER reject_atomicity_ledger BEFORE INSERT ON financial_ledger
    WHEN NEW.decision_id = 'decision-atomicity-test'
    BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END`);

  assert.throws(
    () => persistDecisionAction({ decision, action: 'ACCEPT', farm, chargingEfficiency: 0.92, dischargingEfficiency: 0.92 }),
    /forced ledger failure/,
  );
  const after = getPersistedFarmState(farm.farmId);
  assert.deepEqual(after.state, before.state);
  assert.equal(after.stateVersion, before.stateVersion);
  assert.equal(db.prepare('SELECT status FROM decision_proposals WHERE decision_id=?').get(decision.decisionId).status, 'PENDING');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM applied_simulated_allocations WHERE decision_id=?').get(decision.decisionId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM decision_events WHERE decision_id=?').get(decision.decisionId).count, 1);
});

test('unknown economics remain null and legacy efficiency provenance is explicit', () => {
  const configuration = initialConfiguration();
  validateConfiguration(configuration);
  assert.equal(configuration.battery.chargingEfficiency.value, 0.92);
  assert.equal(configuration.battery.dischargingEfficiency.value, 0.92);
  assert.equal(configuration.battery.chargingEfficiency.sourceType, 'LEGACY_CODE_ASSUMPTION');
  assert.equal(configuration.battery.degradationCostPerMWh.value, null);
  assert.equal(configuration.economics.marketTransactionFeePerMWh.value, null);
  assert.ok(missingEconomicAssumptions(configuration).includes('economics.importTariffPerMWh'));
});

test('configuration validation distinguishes explicit zero from unknown null', () => {
  const configuration = initialConfiguration();
  configuration.economics.marketTransactionFeePerMWh = {
    value: 0,
    unit: 'INR_PER_MWH',
    sourceType: 'USER_CONFIGURED_SIMULATION',
    sourceRef: 'test',
  };
  assert.doesNotThrow(() => validateConfiguration(configuration));
  configuration.economics.marketTransactionFeePerMWh.sourceType = 'UNAVAILABLE';
  assert.throws(() => validateConfiguration(configuration), /numeric values cannot use sourceType UNAVAILABLE/);
});

test('configuration updates create immutable version history', () => {
  const first = getActiveConfiguration();
  const updated = structuredClone(first.configuration);
  updated.economics.marketTransactionFeePerMWh = { value: 0, unit: 'INR_PER_MWH', sourceType: 'USER_CONFIGURED_SIMULATION', sourceRef: 'operator-test' };
  const second = createConfigurationVersion(updated, { createdBy: 'TEST' });
  assert.equal(second.configVersion, 2);
  const rows = getDatabase().prepare('SELECT status FROM simulation_config_versions ORDER BY config_version').all();
  assert.deepEqual(rows.map(row => row.status), ['SUPERSEDED', 'ACTIVE']);
});

test('cache records miss, stored value, hit, and in-flight reuse metadata', async () => {
  const workflow = startWorkflow({ workflowType: 'CACHE_TEST' });
  const cache = createBucketCache();
  const events = [];
  let release;
  const pendingValue = new Promise(resolve => { release = resolve; });
  const factory = async () => { await pendingValue; return { generatedAt: new Date().toISOString(), value: 1 }; };
  const first = cache.getOrCreate('test', factory, { now: Date.now(), observe: event => events.push(event) });
  const second = cache.getOrCreate('test', factory, { now: Date.now(), observe: event => events.push(event) });
  release();
  await Promise.all([first, second]);
  await cache.getOrCreate('test', factory, { now: Date.now(), observe: event => events.push(event) });
  completeWorkflow(workflow);
  assert.equal(events[0].type, 'CACHE_MISS');
  assert.ok(events.some(event => event.reusedInFlight === true));
  assert.ok(events.some(event => event.type === 'CACHE_STORED'));
  assert.ok(events.some(event => event.type === 'CACHE_HIT' && event.reusedInFlight === false));
});

test('workflow details persist correlated events and redact secret-shaped fields', () => {
  const workflow = startWorkflow({ workflowType: 'TRACE_TEST', metadata: { apiKey: 'must-not-appear', safe: 'visible' } });
  completeWorkflow(workflow, { status: 'ok' });
  const details = getWorkflowDetails(workflow.workflowId);
  assert.equal(details.workflow.status, 'COMPLETED');
  assert.deepEqual(details.events.map(event => event.eventType), ['WORKFLOW_STARTED', 'WORKFLOW_COMPLETED']);
  assert.equal(details.workflow.requestMetadata.apiKey, '[REDACTED]');
  assert.equal(sanitize({ authorization: 'secret' }).authorization, '[REDACTED]');
});

test('failed weather-driven generation is recorded and does not use historical fallback', async () => {
  const workflow = startWorkflow({ workflowType: 'FAILED_GENERATION_TEST', farmId: farms[0].farmId });
  const configuration = initialConfiguration();
  configuration.generationSimulation.farms[farms[0].farmId] = {
    ...configuration.generationSimulation.farms[farms[0].farmId],
    ...structuredClone(phase2aProfile.farms[farms[0].farmId]),
  };
  const service = createGenerationService({
    weatherService: { getForecast: async () => { const error = new Error('simulated provider failure'); error.code = 'WEATHER_PROVIDER_FAILED'; throw error; } },
    configurationProvider: () => ({ configVersion: 9, configuration }),
  });
  const result = await service.getForecast(farms[0], { refresh: true, workflowId: workflow.workflowId });
  completeWorkflow(workflow, { status: result.status, source: result.source });
  const details = getWorkflowDetails(workflow.workflowId);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(details.components[0].status, 'FAILED');
  assert.equal(details.components[0].error.code, 'WEATHER_PROVIDER_FAILED');
  assert.ok(details.events.some(event => event.eventType === 'COMPONENT_FAILED'));
  assert.ok(!details.events.some(event => event.eventType === 'FALLBACK_USED'));
  assert.ok(!details.events.some(event => event.eventType === 'COMPONENT_COMPLETED' && event.component === 'GENERATION_SIMULATION'));
});

test('shared subprocess runner handles success, invalid JSON, nonzero exit, and timeout', async () => {
  const success = await runJsonProcess({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({ok:true}))'], timeoutMs: 1000, maxOutputBytes: 10000 });
  assert.equal(success.data.ok, true);

  await assert.rejects(
    runJsonProcess({ command: process.execPath, args: ['-e', 'process.stdout.write("not-json")'], timeoutMs: 1000, maxOutputBytes: 10000 }),
    error => error.code === 'PROCESS_INVALID_JSON',
  );
  await assert.rejects(
    runJsonProcess({ command: process.execPath, args: ['-e', 'process.stderr.write("failed"); process.exit(3)'], timeoutMs: 1000, maxOutputBytes: 10000 }),
    error => error.code === 'PROCESS_NONZERO_EXIT' && error.metadata.stderr === 'failed',
  );
  await assert.rejects(
    runJsonProcess({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30, maxOutputBytes: 10000 }),
    error => error.code === 'PROCESS_TIMEOUT',
  );
});

