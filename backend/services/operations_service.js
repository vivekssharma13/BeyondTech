const { recordActivity } = require('./runtime_store');

const BATTERY_MODES = ['AUTO', 'CHARGE', 'DISCHARGE', 'IDLE'];
const OPERATING_MODES = ['AI_ASSISTED', 'MANUAL'];

function operationsFor(farm) {
  return {
    farmId: farm.farmId,
    simulation: true,
    reservePct: farm.reservePct,
    batteryMode: farm.batteryMode,
    gridExportLimitMW: farm.gridExportLimitMW,
    gridImportAllowed: farm.gridImportAllowed,
    gridImportLimitMW: farm.gridImportLimitMW,
    currentImportMW: farm.currentImportMW,
    outputLimitPct: farm.outputLimitPct,
    operatingMode: farm.operatingMode,
  };
}

function validateNumber(body, field, min, max) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  if (!Number.isFinite(body[field]) || body[field] < min || body[field] > max) {
    throw new TypeError(`${field} must be between ${min} and ${max}`);
  }
}

function updateOperations(farm, body) {
  const allowed = ['reservePct', 'batteryMode', 'gridExportLimitMW', 'gridImportLimitMW', 'outputLimitPct', 'operatingMode'];
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw new TypeError(`Unsupported operations field: ${unknown[0]}`);
  validateNumber(body, 'reservePct', 0, 100);
  validateNumber(body, 'gridExportLimitMW', 0, farm.connectionExportCapacityMW);
  validateNumber(body, 'gridImportLimitMW', 0, farm.connectionImportCapacityMW);
  validateNumber(body, 'outputLimitPct', 0, 100);
  if (body.batteryMode && !BATTERY_MODES.includes(body.batteryMode)) throw new TypeError(`batteryMode must be one of ${BATTERY_MODES.join(', ')}`);
  if (body.operatingMode && !OPERATING_MODES.includes(body.operatingMode)) throw new TypeError(`operatingMode must be one of ${OPERATING_MODES.join(', ')}`);

  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, field)) farm[field] = body[field];
  }
  const state = operationsFor(farm);
  recordActivity({ type: 'OPERATIONS_UPDATED', farmId: farm.farmId, message: `Simulated operating settings updated for ${farm.name}.` });
  return { ...state, status: 'APPLIED' };
}

module.exports = { operationsFor, updateOperations, BATTERY_MODES, OPERATING_MODES };
