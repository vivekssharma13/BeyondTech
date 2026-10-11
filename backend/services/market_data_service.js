const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getDatabase, transaction, json } = require('./database_service');
const {
  marketDefinitionId,
  validateMarketDefinition,
  stableJson,
  checksum,
  requireText,
} = require('./market_contract_service');

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_IMPORT_STORAGE = path.join(__dirname, '..', 'data', 'market_imports');

class MarketImportError extends TypeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MarketImportError';
    this.code = code;
    this.details = details;
  }
}

function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) throw new MarketImportError('EMPTY_FILE', 'CSV file is empty');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { record.push(field); field = ''; }
    else if (character === '\n') { record.push(field); records.push(record); record = []; field = ''; }
    else if (character !== '\r') field += character;
  }
  if (quoted) throw new MarketImportError('INVALID_CSV', 'CSV contains an unterminated quoted field');
  if (field.length || record.length) { record.push(field); records.push(record); }
  const nonEmpty = records.filter(row => row.some(value => value.trim() !== ''));
  if (nonEmpty.length < 2) throw new MarketImportError('EMPTY_DATASET', 'CSV must contain a header and at least one data row');
  const headers = nonEmpty[0].map(value => value.trim());
  if (headers.some((value, index) => !value || headers.indexOf(value) !== index)) throw new MarketImportError('INVALID_HEADERS', 'CSV headers must be non-empty and unique');
  return nonEmpty.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) throw new MarketImportError('INVALID_CSV_ROW', `CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index].trim()]));
  });
}

function parseZonedTimestamp(value, field) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new MarketImportError('TIMESTAMP_TIMEZONE_REQUIRED', `${field} must be ISO-8601 with Z or an explicit UTC offset`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MarketImportError('INVALID_TIMESTAMP', `${field} is not a valid ISO-8601 timestamp`);
  return { original: value, epochMs: parsed, utc: new Date(parsed).toISOString() };
}

function decimalToScaledInteger(value, multiplier, field) {
  const text = String(value).trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new MarketImportError('INVALID_PRICE', `${field} must be a plain decimal number`);
  const fraction = match[3] || '';
  const denominator = 10n ** BigInt(fraction.length);
  const magnitude = BigInt(match[2] + fraction);
  const signed = match[1] === '-' ? -magnitude : magnitude;
  const scaled = signed * BigInt(multiplier);
  if (scaled % denominator !== 0n) throw new MarketImportError('UNSUPPORTED_PRICE_PRECISION', `${field} cannot be represented exactly in paise per MWh`);
  const result = scaled / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new MarketImportError('PRICE_OUT_OF_RANGE', `${field} is outside the supported exact integer range`);
  return Number(result);
}

function priceToPaisePerMWh(value, unit, field = 'price') {
  if (unit === 'INR_PER_MWH') return decimalToScaledInteger(value, 100, field);
  if (unit === 'INR_PER_KWH') return decimalToScaledInteger(value, 100000, field);
  throw new MarketImportError('UNSUPPORTED_PRICE_UNIT', `Unsupported price unit: ${unit}`);
}

function normalizeOptionalTimestamp(value, field) {
  if (value === null || value === undefined || value === '') return null;
  return parseZonedTimestamp(value, field).utc;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new MarketImportError('INVALID_MANIFEST', 'Import manifest must be a JSON object');
  const required = ['datasetId', 'exchange', 'product', 'pricingArea', 'currency', 'priceUnit', 'timezone', 'originalSource', 'sourceReference', 'retrievalTimestamp', 'expectedDeliveryStart', 'expectedDeliveryEnd'];
  for (const field of required) requireText(manifest[field], `manifest.${field}`);
  validateMarketDefinition(manifest.marketDefinition);
  if (manifest.marketDefinition.sourceMode !== 'HISTORICAL_DATA') throw new MarketImportError('INVALID_SOURCE_MODE', 'Historical CSV imports require marketDefinition.sourceMode HISTORICAL_DATA');
  if (manifest.marketDefinition.dataProvenance.sourceType !== 'OBSERVED_MARKET_PRICE') {
    throw new MarketImportError('INVALID_PROVENANCE', 'Historical CSV imports require OBSERVED_MARKET_PRICE provenance');
  }
  requireText(manifest.marketDefinition.dataProvenance.sourceRef, 'manifest.marketDefinition.dataProvenance.sourceRef');
  requireText(manifest.marketDefinition.dataProvenance.permission, 'manifest.marketDefinition.dataProvenance.permission');
  if (manifest.currency !== 'INR') throw new MarketImportError('UNSUPPORTED_CURRENCY', 'Historical market imports currently require INR');
  if (!['INR_PER_MWH', 'INR_PER_KWH'].includes(manifest.priceUnit)) throw new MarketImportError('UNSUPPORTED_PRICE_UNIT', 'priceUnit must be INR_PER_MWH or INR_PER_KWH');
  if (manifest.marketDefinition.marketTimezone !== manifest.timezone) throw new MarketImportError('TIMEZONE_MISMATCH', 'Manifest timezone must match the market definition timezone');
  if (manifest.marketDefinition.referencePricingZone !== manifest.pricingArea) throw new MarketImportError('PRICING_AREA_MISMATCH', 'Manifest pricingArea must match the market definition referencePricingZone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: manifest.timezone }).format(new Date(0));
  } catch {
    throw new MarketImportError('INVALID_TIMEZONE', 'Manifest timezone must be a valid IANA timezone');
  }
  parseZonedTimestamp(manifest.retrievalTimestamp, 'manifest.retrievalTimestamp');
  const expectedStart = parseZonedTimestamp(manifest.expectedDeliveryStart, 'manifest.expectedDeliveryStart');
  const expectedEnd = parseZonedTimestamp(manifest.expectedDeliveryEnd, 'manifest.expectedDeliveryEnd');
  if (expectedStart.epochMs % FIFTEEN_MINUTES_MS !== 0 || expectedEnd.epochMs % FIFTEEN_MINUTES_MS !== 0 || expectedEnd.epochMs <= expectedStart.epochMs) {
    throw new MarketImportError('INVALID_EXPECTED_RANGE', 'Expected delivery range must use increasing 15-minute boundaries');
  }
  normalizeOptionalTimestamp(manifest.publicationTimestamp, 'manifest.publicationTimestamp');
  if (manifest.configurationVersion !== null && manifest.configurationVersion !== undefined
      && (!Number.isInteger(manifest.configurationVersion) || manifest.configurationVersion < 1)) {
    throw new MarketImportError('INVALID_CONFIGURATION_VERSION', 'manifest.configurationVersion must be null or a positive integer');
  }
  return manifest;
}

function normalizeRows(csvRows, manifest) {
  const requiredHeaders = ['delivery_start', 'delivery_end', 'price'];
  for (const header of requiredHeaders) {
    if (!Object.prototype.hasOwnProperty.call(csvRows[0], header)) throw new MarketImportError('MISSING_COLUMN', `CSV is missing required column: ${header}`);
  }
  const identities = new Set();
  return csvRows.map((row, index) => {
    const rowNumber = index + 2;
    const start = parseZonedTimestamp(row.delivery_start, `row ${rowNumber} delivery_start`);
    const end = parseZonedTimestamp(row.delivery_end, `row ${rowNumber} delivery_end`);
    if (start.epochMs % FIFTEEN_MINUTES_MS !== 0 || end.epochMs % FIFTEEN_MINUTES_MS !== 0) {
      throw new MarketImportError('MISALIGNED_INTERVAL', `Row ${rowNumber} timestamps must align to 15-minute UTC boundaries`);
    }
    if (end.epochMs - start.epochMs !== FIFTEEN_MINUTES_MS) throw new MarketImportError('INVALID_INTERVAL_LENGTH', `Row ${rowNumber} must cover exactly 15 minutes`);
    if (row.currency && row.currency !== manifest.currency) throw new MarketImportError('CURRENCY_MISMATCH', `Row ${rowNumber} currency does not match the manifest`);
    const priceUnit = row.price_unit || manifest.priceUnit;
    if (priceUnit !== manifest.priceUnit) throw new MarketImportError('UNIT_MISMATCH', `Row ${rowNumber} price_unit does not match the manifest`);
    const revisionIdentifier = row.revision_identifier || manifest.revisionIdentifier || null;
    const identity = `${start.utc}|${end.utc}|${revisionIdentifier || ''}`;
    if (identities.has(identity)) throw new MarketImportError('DUPLICATE_INTERVAL', `Duplicate delivery interval/revision at CSV row ${rowNumber}`, { identity });
    identities.add(identity);
    return {
      rowNumber,
      raw: row,
      originalDeliveryStart: start.original,
      originalDeliveryEnd: end.original,
      deliveryStartUtc: start.utc,
      deliveryEndUtc: end.utc,
      startMs: start.epochMs,
      endMs: end.epochMs,
      originalPriceText: row.price,
      originalPriceUnit: priceUnit,
      pricePaisePerMWh: priceToPaisePerMWh(row.price, priceUnit, `row ${rowNumber} price`),
      publicationTimestamp: normalizeOptionalTimestamp(row.publication_timestamp || manifest.publicationTimestamp, `row ${rowNumber} publication_timestamp`),
      revisionIdentifier,
    };
  });
}

function detectMissingBlocks(rows, expectedStartMs = Math.min(...rows.map(row => row.startMs)), expectedEndMs = Math.max(...rows.map(row => row.endMs))) {
  const starts = new Set(rows.map(row => row.startMs));
  const outside = rows.filter(row => row.startMs < expectedStartMs || row.endMs > expectedEndMs);
  if (outside.length) throw new MarketImportError('INTERVAL_OUTSIDE_EXPECTED_RANGE', `${outside.length} interval(s) fall outside the declared delivery range`);
  const missing = [];
  for (let cursor = expectedStartMs; cursor < expectedEndMs; cursor += FIFTEEN_MINUTES_MS) {
    if (!starts.has(cursor)) missing.push(new Date(cursor).toISOString());
  }
  return missing;
}

function writeImmutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, contents, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(filePath);
    const expected = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (!existing.equals(expected)) throw new Error(`Immutable import artifact collision at ${filePath}`);
  }
}

function definitionRecord(definition, createdAt) {
  return {
    id: marketDefinitionId(definition),
    values: [
      marketDefinitionId(definition), definition.marketId, definition.definitionVersion, definition.displayName,
      definition.marketType, definition.referencePricingZone, definition.currency, definition.priceUnit,
      definition.nativeIntervalMinutes, definition.marketTimezone, definition.sourceMode, json(definition.dataProvenance),
      definition.congestionLimitations, definition.configurationVersion ?? null, createdAt,
    ],
  };
}

function assertDefinitionCompatible(existing, definition) {
  const comparable = {
    marketId: existing.market_id, definitionVersion: existing.definition_version, displayName: existing.display_name,
    marketType: existing.market_type, referencePricingZone: existing.reference_pricing_zone, currency: existing.currency,
    priceUnit: existing.price_unit, nativeIntervalMinutes: existing.native_interval_minutes, marketTimezone: existing.market_timezone,
    sourceMode: existing.source_mode, dataProvenance: JSON.parse(existing.data_provenance_json),
    congestionLimitations: existing.congestion_limitations, configurationVersion: existing.configuration_version,
  };
  const expected = { ...definition, configurationVersion: definition.configurationVersion ?? null };
  if (stableJson(comparable) !== stableJson(expected)) throw new MarketImportError('MARKET_DEFINITION_CONFLICT', `Market definition ${marketDefinitionId(definition)} already exists with different metadata`);
}

function importHistoricalMarketCsv({ csvPath, manifestPath = null, manifest: suppliedManifest = null, storageDirectory = DEFAULT_IMPORT_STORAGE } = {}) {
  if (!csvPath) throw new MarketImportError('FILE_REQUIRED', 'csvPath is required');
  const csvBuffer = fs.readFileSync(csvPath);
  const manifest = validateManifest(suppliedManifest || JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  const rows = normalizeRows(parseCsv(csvBuffer.toString('utf8')), manifest);
  const expectedStart = parseZonedTimestamp(manifest.expectedDeliveryStart, 'manifest.expectedDeliveryStart');
  const expectedEnd = parseZonedTimestamp(manifest.expectedDeliveryEnd, 'manifest.expectedDeliveryEnd');
  const missingBlocks = detectMissingBlocks(rows, expectedStart.epochMs, expectedEnd.epochMs);
  const dataQualityStatus = missingBlocks.length ? 'INCOMPLETE' : 'COMPLETE';
  const fileChecksum = crypto.createHash('sha256').update(csvBuffer).digest('hex');
  const manifestContents = `${stableJson(manifest)}\n`;
  const manifestChecksum = checksum(manifestContents);
  const definitionId = marketDefinitionId(manifest.marketDefinition);
  const db = getDatabase();
  const existingDataset = db.prepare('SELECT * FROM imported_market_datasets WHERE dataset_id=?').get(manifest.datasetId);
  if (existingDataset) {
    if (existingDataset.checksum_sha256 === fileChecksum && existingDataset.manifest_checksum_sha256 === manifestChecksum) {
      return { datasetId: manifest.datasetId, status: existingDataset.status, dataQualityStatus: existingDataset.data_quality_status, rowCount: existingDataset.row_count, missingBlockCount: missingBlocks.length, idempotent: true };
    }
    throw new MarketImportError('DATASET_ID_CONFLICT', `Dataset ${manifest.datasetId} already exists with different immutable content`);
  }
  const duplicateContent = db.prepare(`SELECT dataset_id FROM imported_market_datasets
    WHERE market_definition_id=? AND checksum_sha256=? AND COALESCE(revision_identifier, '')=COALESCE(?, '')`).get(definitionId, fileChecksum, manifest.revisionIdentifier || null);
  if (duplicateContent) throw new MarketImportError('DATASET_CONTENT_ALREADY_IMPORTED', `Source content is already imported as ${duplicateContent.dataset_id}`);
  const identityLookup = db.prepare(`SELECT dataset_id FROM market_price_intervals WHERE market_id=?
    AND market_product=? AND pricing_area=? AND delivery_start_utc=? AND delivery_end_utc=?
    AND original_source=? AND COALESCE(revision_identifier, '')=COALESCE(?, '')`);
  for (const row of rows) {
    const conflict = identityLookup.get(manifest.marketDefinition.marketId, manifest.product, manifest.pricingArea,
      row.deliveryStartUtc, row.deliveryEndUtc, manifest.originalSource, row.revisionIdentifier);
    if (conflict) throw new MarketImportError('INTERVAL_REVISION_CONFLICT', `Interval ${row.deliveryStartUtc} revision ${row.revisionIdentifier || '(unspecified)'} already exists in dataset ${conflict.dataset_id}`);
  }

  const storedCsvPath = path.join(storageDirectory, `${fileChecksum}.csv`);
  const storedManifestPath = path.join(storageDirectory, `${fileChecksum}.manifest.json`);
  writeImmutable(storedCsvPath, csvBuffer);
  writeImmutable(storedManifestPath, manifestContents);

  const importedAt = new Date().toISOString();
  const retrievalTimestamp = parseZonedTimestamp(manifest.retrievalTimestamp, 'manifest.retrievalTimestamp').utc;
  const publicationTimestamp = normalizeOptionalTimestamp(manifest.publicationTimestamp, 'manifest.publicationTimestamp');
  transaction(database => {
    const existingDefinition = database.prepare('SELECT * FROM market_definitions WHERE market_definition_id=?').get(definitionId);
    if (existingDefinition) assertDefinitionCompatible(existingDefinition, manifest.marketDefinition);
    else {
      const definition = definitionRecord(manifest.marketDefinition, importedAt);
      database.prepare(`INSERT INTO market_definitions (
        market_definition_id, market_id, definition_version, display_name, market_type, reference_pricing_zone,
        currency, price_unit, native_interval_minutes, market_timezone, source_mode, data_provenance_json,
        congestion_limitations, configuration_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...definition.values);
    }
    database.prepare(`INSERT INTO imported_market_datasets (
      dataset_id, market_definition_id, exchange_name, market_product, pricing_area, declared_currency,
      declared_price_unit, original_timezone, original_source, source_reference, original_filename,
      stored_source_path, checksum_sha256, manifest_checksum_sha256, publication_timestamp,
      retrieval_timestamp, import_timestamp, expected_delivery_start_utc, expected_delivery_end_utc,
      revision_identifier, row_count, data_quality_status,
      configuration_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(manifest.datasetId, definitionId, manifest.exchange, manifest.product, manifest.pricingArea, manifest.currency,
        manifest.priceUnit, manifest.timezone, manifest.originalSource, manifest.sourceReference, path.basename(csvPath),
        storedCsvPath, fileChecksum, manifestChecksum, publicationTimestamp, retrievalTimestamp, importedAt,
        expectedStart.utc, expectedEnd.utc,
        manifest.revisionIdentifier || null, rows.length, dataQualityStatus, manifest.configurationVersion ?? null, 'IMPORTED');

    const insertObservation = database.prepare(`INSERT INTO market_observations (
      observation_id, dataset_id, source_row_number, original_delivery_start, original_delivery_end,
      original_timezone, original_price_text, original_price_unit, delivery_start_utc, delivery_end_utc,
      price_paise_per_mwh, publication_timestamp, revision_identifier, data_quality_status, raw_record_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertInterval = database.prepare(`INSERT INTO market_price_intervals (
      price_interval_id, market_definition_id, market_id, dataset_id, observation_id, market_product,
      pricing_area, delivery_start_utc, delivery_end_utc, price_paise_per_mwh, currency, price_unit,
      source_type, original_source, retrieval_timestamp, publication_timestamp, revision_identifier,
      data_quality_status, configuration_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'INR_PER_MWH', 'OBSERVED_MARKET_PRICE', ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      const observationId = `market-observation-${crypto.randomUUID()}`;
      insertObservation.run(observationId, manifest.datasetId, row.rowNumber, row.originalDeliveryStart, row.originalDeliveryEnd,
        manifest.timezone, row.originalPriceText, row.originalPriceUnit, row.deliveryStartUtc, row.deliveryEndUtc,
        row.pricePaisePerMWh, row.publicationTimestamp, row.revisionIdentifier, 'VALID', json(row.raw), importedAt);
      insertInterval.run(`market-price-${crypto.randomUUID()}`, definitionId, manifest.marketDefinition.marketId,
        manifest.datasetId, observationId, manifest.product, manifest.pricingArea, row.deliveryStartUtc,
        row.deliveryEndUtc, row.pricePaisePerMWh, manifest.originalSource, retrievalTimestamp,
        row.publicationTimestamp, row.revisionIdentifier, 'VALID', manifest.configurationVersion ?? null, importedAt);
    }
    const qualityInsert = database.prepare(`INSERT INTO market_data_quality_results
      (quality_result_id, dataset_id, check_name, status, affected_count, details_json, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    qualityInsert.run(`market-quality-${crypto.randomUUID()}`, manifest.datasetId, 'INTERVAL_ALIGNMENT', 'PASSED', 0, '{}', importedAt);
    qualityInsert.run(`market-quality-${crypto.randomUUID()}`, manifest.datasetId, 'DUPLICATE_INTERVALS', 'PASSED', 0, '{}', importedAt);
    qualityInsert.run(`market-quality-${crypto.randomUUID()}`, manifest.datasetId, 'MISSING_DELIVERY_BLOCKS', missingBlocks.length ? 'WARNING' : 'PASSED', missingBlocks.length, json({ missingDeliveryStartsUtc: missingBlocks }), importedAt);
    qualityInsert.run(`market-quality-${crypto.randomUUID()}`, manifest.datasetId, 'PRICE_UNIT_CONVERSION', 'PASSED', 0, json({ inputUnit: manifest.priceUnit, canonicalUnit: 'INR_PER_MWH' }), importedAt);
  });
  return { datasetId: manifest.datasetId, status: 'IMPORTED', dataQualityStatus, rowCount: rows.length, missingBlockCount: missingBlocks.length, checksumSha256: fileChecksum, storedSourcePath: storedCsvPath, idempotent: false };
}

function listDatasetIntervals(datasetId) {
  requireText(datasetId, 'datasetId');
  return getDatabase().prepare(`SELECT price_interval_id AS priceIntervalId, market_id AS marketId,
    market_product AS marketProduct, pricing_area AS pricingArea, delivery_start_utc AS deliveryStartUtc,
    delivery_end_utc AS deliveryEndUtc, price_paise_per_mwh AS pricePaisePerMWh, currency, price_unit AS priceUnit,
    source_type AS sourceType, original_source AS originalSource, retrieval_timestamp AS retrievalTimestamp,
    publication_timestamp AS publicationTimestamp, revision_identifier AS revisionIdentifier,
    data_quality_status AS dataQualityStatus, configuration_version AS configurationVersion
    FROM market_price_intervals WHERE dataset_id=? ORDER BY delivery_start_utc, COALESCE(revision_identifier, '')`).all(datasetId);
}

function normalizePlanningInterval(interval, index) {
  const start = Date.parse(interval.intervalStart);
  const end = Date.parse(interval.intervalEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== HOUR_MS) throw new TypeError(`planningIntervals[${index}] must be an exact one-hour interval`);
  if (start % FIFTEEN_MINUTES_MS !== 0) throw new TypeError(`planningIntervals[${index}] must align to a 15-minute boundary`);
  return { intervalStart: new Date(start).toISOString(), intervalEnd: new Date(end).toISOString(), start, end };
}

function aggregateMarketIntervalsToHours({ planningIntervals, priceIntervals }) {
  if (!Array.isArray(planningIntervals) || !planningIntervals.length) throw new TypeError('planningIntervals must be a non-empty array');
  if (!Array.isArray(priceIntervals)) throw new TypeError('priceIntervals must be an array');
  const blocksByStart = new Map();
  for (const block of priceIntervals) {
    const startValue = block.deliveryStartUtc ?? block.delivery_start_utc;
    const endValue = block.deliveryEndUtc ?? block.delivery_end_utc;
    const paiseValue = block.pricePaisePerMWh ?? block.price_paise_per_mwh;
    const start = Date.parse(startValue);
    const end = Date.parse(endValue);
    if (!Number.isFinite(start) || end - start !== FIFTEEN_MINUTES_MS || start % FIFTEEN_MINUTES_MS !== 0) throw new TypeError('priceIntervals contain a non-canonical 15-minute block');
    if (!Number.isSafeInteger(paiseValue)) throw new TypeError('priceIntervals.pricePaisePerMWh must be an exact safe integer');
    if (blocksByStart.has(start)) throw new TypeError(`Multiple price intervals exist for ${new Date(start).toISOString()}; select one revision before aggregation`);
    blocksByStart.set(start, block);
  }
  return planningIntervals.map((input, index) => {
    const interval = normalizePlanningInterval(input, index);
    const requiredStarts = Array.from({ length: 4 }, (_, blockIndex) => interval.start + blockIndex * FIFTEEN_MINUTES_MS);
    const blocks = requiredStarts.map(start => blocksByStart.get(start));
    const missing = requiredStarts.filter((start, blockIndex) => !blocks[blockIndex]).map(start => new Date(start).toISOString());
    if (missing.length) return { intervalStart: interval.intervalStart, intervalEnd: interval.intervalEnd, status: 'INCOMPLETE', priceINRPerMWh: null, missingDeliveryStartsUtc: missing, sourceTypes: ['UNAVAILABLE'] };
    const sumPaise = blocks.reduce((sum, block) => sum + (block.pricePaisePerMWh ?? block.price_paise_per_mwh), 0);
    return {
      intervalStart: interval.intervalStart,
      intervalEnd: interval.intervalEnd,
      status: 'COMPLETE',
      priceINRPerMWh: sumPaise / 4 / 100,
      aggregation: 'ARITHMETIC_MEAN_OF_FOUR_15_MINUTE_PRICES_FOR_CONSTANT_POWER',
      nativeBlockCount: 4,
      sourceTypes: [...new Set(blocks.map(block => block.sourceType ?? block.source_type))],
      configurationVersions: [...new Set(blocks.map(block => block.configurationVersion ?? block.configuration_version).filter(value => value !== null && value !== undefined))],
    };
  });
}

function marketDataReadiness() {
  const db = getDatabase();
  const datasets = db.prepare(`SELECT dataset_id AS datasetId, data_quality_status AS dataQualityStatus,
    row_count AS rowCount, market_definition_id AS marketDefinitionId, import_timestamp AS importedAt
    FROM imported_market_datasets ORDER BY import_timestamp DESC`).all();
  return { status: datasets.some(dataset => dataset.dataQualityStatus === 'COMPLETE') ? 'DATA_AVAILABLE' : 'INCOMPLETE_DATA', datasets };
}

module.exports = {
  FIFTEEN_MINUTES_MS,
  HOUR_MS,
  DEFAULT_IMPORT_STORAGE,
  MarketImportError,
  parseCsv,
  parseZonedTimestamp,
  priceToPaisePerMWh,
  validateManifest,
  normalizeRows,
  detectMissingBlocks,
  importHistoricalMarketCsv,
  listDatasetIntervals,
  aggregateMarketIntervalsToHours,
  marketDataReadiness,
};
