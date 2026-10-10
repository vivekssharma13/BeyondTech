const { createId, recordAgentRun, recordActivity } = require('./runtime_store');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Number(clamp(value, 0, Number.MAX_SAFE_INTEGER).toFixed(1));
}

function horizonValue(forecast, horizon, field) {
  return forecast.horizons.find(item => item.horizon === horizon)?.[field] ?? 0;
}

function optimizeFarm({ farm, generationForecast, marketForecast, now = Date.now() }) {
  const generation1h = horizonValue(generationForecast, '1h', 'predictedGenerationMW');
  const generation6h = horizonValue(generationForecast, '6h', 'predictedGenerationMW');
  const exportHeadroom = Math.max(0, farm.gridExportLimitMW - farm.currentExportMW);
  const importHeadroom = farm.gridImportAllowed
    ? Math.max(0, farm.gridImportLimitMW - farm.currentImportMW)
    : 0;
  const effectiveBatteryCapacityMWh = farm.batteryCapacityMWh * (farm.batterySohPct ?? 100) / 100;
  const batteryDischargeAboveReserveMWh = Math.max(0, effectiveBatteryCapacityMWh * (farm.batterySocPct - farm.reservePct) / 100);
  const batteryRoomMWh = Math.max(0, effectiveBatteryCapacityMWh * ((farm.batterySafeChargePct ?? 95) - farm.batterySocPct) / 100);
  const batteryPowerLimit = Math.max(0, farm.batteryMaxPowerMW ?? Math.min(40, farm.batteryCapacityMWh * 0.2));
  const availableBatteryDischargeMW = Math.min(batteryPowerLimit, batteryDischargeAboveReserveMWh);
  const availableBatteryChargeMW = Math.min(batteryPowerLimit, batteryRoomMWh);
  const generationSurplusMW = Math.max(0, farm.curtailmentMW || 0, farm.currentGenerationMW - farm.currentExportMW, generation1h - farm.currentExportMW);
  const safeFarmOutputMW = farm.capacityMW * farm.availabilityPct / 100 * (farm.outputLimitPct ?? 100) / 100;
  const safeFarmHeadroomMW = Math.max(0, safeFarmOutputMW - farm.currentExportMW);
  const sellQuantity = round(Math.min(exportHeadroom, safeFarmHeadroomMW, generationSurplusMW + availableBatteryDischargeMW));
  const buyQuantity = round(Math.min(
    importHeadroom,
    availableBatteryChargeMW,
    farm.maximumPurchaseMW ?? importHeadroom,
  ));

  const buyConstraints = [];
  if (!farm.gridImportAllowed) buyConstraints.push('GRID_IMPORT_NOT_ALLOWED');
  if (importHeadroom <= 0) buyConstraints.push('NO_GRID_IMPORT_HEADROOM');
  if (batteryRoomMWh <= 0) buyConstraints.push('BATTERY_AT_SAFE_CHARGE_LIMIT');
  if (buyQuantity <= 0 && buyConstraints.length === 0) buyConstraints.push('NO_PERMITTED_IMPORT_QUANTITY');

  const sellConstraints = [];
  if (exportHeadroom <= 0) sellConstraints.push('NO_GRID_EXPORT_HEADROOM');
  if (generationSurplusMW + availableBatteryDischargeMW <= 0) sellConstraints.push('NO_ENERGY_AVAILABLE_FOR_EXPORT');
  if (farm.batterySocPct <= farm.reservePct && generationSurplusMW <= 0) sellConstraints.push('BATTERY_RESERVE_PROTECTED');
  if (safeFarmHeadroomMW <= 0) sellConstraints.push('FARM_OUTPUT_LIMIT_REACHED');

  const candidateStrategies = [
    {
      action: 'BUY',
      feasible: buyConstraints.length === 0 && buyQuantity > 0,
      quantityMW: buyQuantity,
      reason: buyQuantity > 0
        ? `Battery capacity and grid import headroom permit up to ${buyQuantity} MW for storage.`
        : 'No safe import quantity is currently available for battery storage.',
      constraints: buyConstraints,
    },
    {
      action: 'SELL',
      feasible: sellConstraints.length === 0 && sellQuantity > 0,
      quantityMW: sellQuantity,
      reason: sellQuantity > 0
        ? `Generation, battery reserve and export limits permit up to ${sellQuantity} MW.`
        : 'No safe export quantity is currently available.',
      constraints: sellConstraints,
    },
    {
      action: 'HOLD',
      feasible: true,
      quantityMW: 0,
      reason: 'Maintaining the current position does not violate a physical constraint.',
      constraints: [],
    },
  ];

  const agentRunId = createId('optimizer-run');
  const result = {
    agent: 'OPTIMIZER',
    agentRunId,
    status: 'COMPLETED',
    farmId: farm.farmId,
    generatedAt: new Date(now).toISOString(),
    source: 'SIMULATED',
    logic: 'RULE_BASED',
    inputs: {
      generationForecastRunId: generationForecast.agentRunId,
      marketForecastRunId: marketForecast.agentRunId,
    },
    candidateStrategies,
    // Compatibility field for existing consumers. These are candidates, not
    // final decisions.
    recommendations: candidateStrategies,
    operationalAdjustments: {
      reservePct: farm.reservePct,
      effectiveBatteryCapacityMWh: round(effectiveBatteryCapacityMWh),
      availableBatteryDischargeMW: round(availableBatteryDischargeMW),
      availableBatteryChargeMW: round(availableBatteryChargeMW),
      gridExportHeadroomMW: round(exportHeadroom),
      gridImportHeadroomMW: round(importHeadroom),
      generation1hMW: round(generation1h),
      generation6hMW: round(generation6h),
    },
  };
  recordAgentRun({ agent: 'OPTIMIZER', agentRunId, farmId: farm.farmId, status: 'COMPLETED', source: result.source, generatedAt: result.generatedAt });
  recordActivity({ type: 'OPTIMIZER_COMPLETED', farmId: farm.farmId, message: `Optimizer calculated feasible BUY, SELL and HOLD quantities for ${farm.name}.` });
  return result;
}

module.exports = { optimizeFarm, clamp };
