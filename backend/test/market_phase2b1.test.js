const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createApiServer } = require('../api_server');
const { getDatabase, closeDatabase } = require('../services/database_service');
const { REFERENCE_MARKET_DEFINITION, validateMarketDefinition } = require('../services/market_contract_service');
const {
  MarketImportError,
  priceToPaisePerMWh,
  importHistoricalMarketCsv,
  listDatasetIntervals,
  aggregateMarketIntervalsToHours,
  marketDataReadiness,
} = require('../services/market_data_service');

let testDirectory;

function manifest(overrides = {}) {
  return {
    datasetId: 'operator-dataset-v1',
    marketDefinition: {
      marketId: 'OPERATOR_DOCUMENTED_MARKET', definitionVersion: 1, displayName: 'Operator documented historical market',
      marketType: 'HISTORICAL_WHOLESALE_ELECTRICITY_MARKET', referencePricingZone: 'DOCUMENTED_AREA',
      currency: 'INR', priceUnit: 'INR_PER_MWH', nativeIntervalMinutes: 15, marketTimezone: 'Asia/Kolkata',
      sourceMode: 'HISTORICAL_DATA', dataProvenance: {
        sourceType: 'OBSERVED_MARKET_PRICE', sourceRef: 'local test fixture', permission: 'TEST_FIXTURE',
      },
      congestionLimitations: 'Defined by the operator-supplied test fixture.', configurationVersion: 3,
    },
    exchange: 'DOCUMENTED_TEST_EXCHANGE', product: 'DOCUMENTED_TEST_PRODUCT', pricingArea: 'DOCUMENTED_AREA',
    currency: 'INR', priceUnit: 'INR_PER_KWH', timezone: 'Asia/Kolkata', originalSource: 'OPERATOR_SUPPLIED_TEST_FIXTURE',
    sourceReference: 'local test fixture', retrievalTimestamp: '2026-01-01T01:00:00+05:30',
    expectedDeliveryStart: '2026-01-01T00:00:00+05:30', expectedDeliveryEnd: '2026-01-01T01:00:00+05:30',
    publicationTimestamp: null, revisionIdentifier: 'R1', configurationVersion: 3,
    ...overrides,
  };
}

function writeCsv(name, rows) {
  const csvPath = path.join(testDirectory, name);
  fs.writeFileSync(csvPath, `delivery_start,delivery_end,price\n${rows.join('\n')}\n`);
  return csvPath;
}

function dispatch(server, url) {
  return new Promise(resolve => {
    const request = new EventEmitter();
    request.method = 'GET';
    request.url = url;
    request.headers = { host: 'localhost' };
    request.socket = { remoteAddress: '127.0.0.1' };
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(payload) { resolve({ status: this.status, body: payload ? JSON.parse(payload) : null }); },
    };
    server.emit('request', request, response);
    queueMicrotask(() => request.emit('end'));
  });
}

const completeRows = [
  '2026-01-01T00:00:00+05:30,2026-01-01T00:15:00+05:30,5.0',
  '2026-01-01T00:15:00+05:30,2026-01-01T00:30:00+05:30,5.1',
  '2026-01-01T00:30:00+05:30,2026-01-01T00:45:00+05:30,-0.5',
  '2026-01-01T00:45:00+05:30,2026-01-01T01:00:00+05:30,0',
];

test.beforeEach(() => {
  testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-phase2b1-'));
  process.env.ENERGY_DB_PATH = path.join(testDirectory, 'market.sqlite');
});

test.afterEach(() => {
  closeDatabase();
  fs.rmSync(testDirectory, { recursive: true, force: true });
  process.env.ENERGY_DB_PATH = ':memory:';
});

test('market migration creates empty Phase 2B.1 tables without fake data', () => {
  const db = getDatabase();
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_definitions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_price_intervals').get().count, 0);
  assert.equal(marketDataReadiness().status, 'INCOMPLETE_DATA');
  assert.doesNotThrow(() => validateMarketDefinition(REFERENCE_MARKET_DEFINITION));
  assert.equal(REFERENCE_MARKET_DEFINITION.sourceMode, 'UNAVAILABLE');
});

test('read-only market endpoints expose an inactive, non-ready contract without creating prices', async () => {
  const server = createApiServer();
  const contract = await dispatch(server, '/api/market/contract');
  assert.equal(contract.status, 200);
  assert.equal(contract.body.marketId, 'INDIA_SIMULATED_REFERENCE_MARKET');
  assert.equal(contract.body.activationStatus, 'INACTIVE');
  assert.equal(contract.body.readiness.status, 'INCOMPLETE_DATA');

  const readiness = await dispatch(server, '/api/market/data-readiness');
  assert.equal(readiness.status, 200);
  assert.equal(readiness.body.status, 'INCOMPLETE_DATA');
  assert.deepEqual(readiness.body.datasets, []);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM market_price_intervals').get().count, 0);
});

test('historical import converts IST to UTC, INR/kWh to exact paise/MWh, and preserves signed zero/negative prices', () => {
  const csvPath = writeCsv('complete.csv', completeRows);
  const result = importHistoricalMarketCsv({ csvPath, manifest: manifest(), storageDirectory: path.join(testDirectory, 'archive') });
  assert.equal(result.dataQualityStatus, 'COMPLETE');
  assert.equal(result.rowCount, 4);
  assert.equal(result.missingBlockCount, 0);
  assert.equal(result.idempotent, false);
  assert.equal(marketDataReadiness().status, 'DATA_AVAILABLE');
  const intervals = listDatasetIntervals('operator-dataset-v1');
  assert.deepEqual(intervals.map(row => row.pricePaisePerMWh), [500000, 510000, -50000, 0]);
  assert.equal(intervals[0].deliveryStartUtc, '2025-12-31T18:30:00.000Z');
  assert.equal(intervals[3].deliveryEndUtc, '2025-12-31T19:30:00.000Z');
  assert.ok(fs.existsSync(result.storedSourcePath));
  assert.equal(getDatabase().prepare('SELECT source_type FROM market_price_intervals LIMIT 1').get().source_type, 'OBSERVED_MARKET_PRICE');
});

test('imports are idempotent across database reopen and changed bytes under the same dataset ID fail closed', () => {
  const csvPath = writeCsv('idempotent.csv', completeRows);
  const options = { csvPath, manifest: manifest(), storageDirectory: path.join(testDirectory, 'archive') };
  const first = importHistoricalMarketCsv(options);
  closeDatabase();
  const second = importHistoricalMarketCsv(options);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM market_price_intervals').get().count, 4);
  fs.writeFileSync(csvPath, fs.readFileSync(csvPath, 'utf8').replace('5.0', '6.0'));
  assert.throws(() => importHistoricalMarketCsv(options), error => error instanceof MarketImportError && error.code === 'DATASET_ID_CONFLICT');
});

test('a distinct revision is preserved instead of overwriting prior interval history', () => {
  const storageDirectory = path.join(testDirectory, 'archive');
  importHistoricalMarketCsv({ csvPath: writeCsv('r1.csv', completeRows), manifest: manifest(), storageDirectory });
  const revised = completeRows.map(row => row.replace(/,(5\.0|5\.1|-0\.5|0)$/, ',6.0'));
  importHistoricalMarketCsv({
    csvPath: writeCsv('r2.csv', revised),
    manifest: manifest({ datasetId: 'operator-dataset-v2', revisionIdentifier: 'R2' }),
    storageDirectory,
  });
  const db = getDatabase();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM market_price_intervals').get().count, 8);
  assert.deepEqual(db.prepare('SELECT DISTINCT revision_identifier AS revision FROM market_price_intervals ORDER BY revision').all().map(row => row.revision), ['R1', 'R2']);
});

test('missing delivery blocks are explicit and hourly aggregation never invents them', () => {
  const rows = completeRows.filter((_, index) => index !== 2);
  const result = importHistoricalMarketCsv({
    csvPath: writeCsv('missing.csv', rows), manifest: manifest(), storageDirectory: path.join(testDirectory, 'archive'),
  });
  assert.equal(result.dataQualityStatus, 'INCOMPLETE');
  assert.equal(result.missingBlockCount, 1);
  assert.equal(marketDataReadiness().status, 'INCOMPLETE_DATA');
  const quality = getDatabase().prepare("SELECT * FROM market_data_quality_results WHERE check_name='MISSING_DELIVERY_BLOCKS'").get();
  assert.equal(quality.status, 'WARNING');
  assert.equal(quality.affected_count, 1);
  const hourly = aggregateMarketIntervalsToHours({
    planningIntervals: [{ intervalStart: '2025-12-31T18:30:00.000Z', intervalEnd: '2025-12-31T19:30:00.000Z' }],
    priceIntervals: listDatasetIntervals('operator-dataset-v1'),
  });
  assert.equal(hourly[0].status, 'INCOMPLETE');
  assert.equal(hourly[0].priceINRPerMWh, null);
  assert.deepEqual(hourly[0].missingDeliveryStartsUtc, ['2025-12-31T19:00:00.000Z']);
});

test('four exact 15-minute prices aggregate by arithmetic mean against supplied planning boundaries', () => {
  importHistoricalMarketCsv({
    csvPath: writeCsv('aggregate.csv', completeRows), manifest: manifest(), storageDirectory: path.join(testDirectory, 'archive'),
  });
  const hourly = aggregateMarketIntervalsToHours({
    planningIntervals: [{ intervalStart: '2025-12-31T18:30:00.000Z', intervalEnd: '2025-12-31T19:30:00.000Z' }],
    priceIntervals: listDatasetIntervals('operator-dataset-v1'),
  });
  assert.equal(hourly[0].status, 'COMPLETE');
  assert.equal(hourly[0].priceINRPerMWh, 2400);
  assert.equal(hourly[0].nativeBlockCount, 4);
  assert.deepEqual(hourly[0].sourceTypes, ['OBSERVED_MARKET_PRICE']);
});

test('invalid alignment, duplicates, unit mismatches, and inexact financial precision are rejected without records', () => {
  const storageDirectory = path.join(testDirectory, 'archive');
  assert.throws(
    () => importHistoricalMarketCsv({
      csvPath: writeCsv('bad-alignment.csv', ['2026-01-01T00:01:00+05:30,2026-01-01T00:16:00+05:30,5']),
      manifest: manifest(), storageDirectory,
    }),
    error => error.code === 'MISALIGNED_INTERVAL',
  );
  assert.throws(
    () => importHistoricalMarketCsv({
      csvPath: writeCsv('duplicate.csv', [completeRows[0], completeRows[0]]), manifest: manifest(), storageDirectory,
    }),
    error => error.code === 'DUPLICATE_INTERVAL',
  );
  assert.throws(() => priceToPaisePerMWh('1.001', 'INR_PER_MWH'), error => error.code === 'UNSUPPORTED_PRICE_PRECISION');
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM imported_market_datasets').get().count, 0);
});
