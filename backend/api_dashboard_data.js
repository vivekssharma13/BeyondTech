const farms = [
  { farmId: 'sunpeak', name: 'SunPeak Solar', type: 'SOLAR', capacityMW: 120, currentGenerationMW: 87.4, forecastGenerationMW: 81.2, status: 'HEALTHY', availabilityPct: 99.1, currentExportMW: 82.7, gridExportLimitMW: 108, connectionExportCapacityMW: 108, gridImportAllowed: true, gridImportLimitMW: 40, connectionImportCapacityMW: 40, currentImportMW: 0, maximumPurchaseMW: 30, batteryCapacityMWh: 240, batterySocPct: 71, batterySohPct: 96, batteryPowerMW: -12, batteryMaxPowerMW: 36, batterySafeChargePct: 95, reservePct: 24, outputLimitPct: 100, batteryMode: 'AUTO', operatingMode: 'AI_ASSISTED', revenueToday: 0, curtailmentMW: 4.7, equipment: { online: 47, total: 48 }, weather: { ghiWm2: 612, dniWm2: 488, dhiWm2: 124, sunshinePct: 48, cloudCoverPct: 64, temperatureC: 29.4, moduleTemperatureC: 42.1, uvIndex: 8.2, visibilityKm: 9.4, precipitationProbabilityPct: 12 } },
  { farmId: 'desertbloom', name: 'Desert Bloom Solar', type: 'SOLAR', capacityMW: 80, currentGenerationMW: 58.6, forecastGenerationMW: 51.8, status: 'WARNING', availabilityPct: 96.8, currentExportMW: 55.9, gridExportLimitMW: 72, connectionExportCapacityMW: 72, gridImportAllowed: true, gridImportLimitMW: 28, connectionImportCapacityMW: 28, currentImportMW: 0, maximumPurchaseMW: 20, batteryCapacityMWh: 140, batterySocPct: 64, batterySohPct: 93, batteryPowerMW: -6, batteryMaxPowerMW: 24, batterySafeChargePct: 95, reservePct: 19, outputLimitPct: 100, batteryMode: 'AUTO', operatingMode: 'AI_ASSISTED', revenueToday: 0, curtailmentMW: 6.2, equipment: { online: 31, total: 32 }, weather: { ghiWm2: 554, dniWm2: 431, dhiWm2: 123, sunshinePct: 42, cloudCoverPct: 72, temperatureC: 31.2, moduleTemperatureC: 46.8, uvIndex: 8.8, visibilityKm: 7.8, precipitationProbabilityPct: 18 } },
  { farmId: 'coastal', name: 'Coastal Wind', type: 'WIND', capacityMW: 150, currentGenerationMW: 102.8, forecastGenerationMW: 111.6, status: 'HEALTHY', availabilityPct: 98.4, currentExportMW: 98.5, gridExportLimitMW: 135, connectionExportCapacityMW: 135, gridImportAllowed: true, gridImportLimitMW: 45, connectionImportCapacityMW: 45, currentImportMW: 0, maximumPurchaseMW: 35, batteryCapacityMWh: 200, batterySocPct: 68, batterySohPct: 97, batteryPowerMW: 0, batteryMaxPowerMW: 40, batterySafeChargePct: 95, reservePct: 28, outputLimitPct: 100, batteryMode: 'AUTO', operatingMode: 'AI_ASSISTED', revenueToday: 0, curtailmentMW: 0, equipment: { online: 46, total: 48 }, weather: { windSpeedMps: 8.7, windDirectionDeg: 244, windGustMps: 13.4, temperatureC: 22.1, airDensityKgM3: 1.18, turbineAvailabilityPct: 98.4, turbinesOnline: 46, turbinesTotal: 48, capacityFactorPct: 68 } },
  { farmId: 'highland', name: 'Highland Wind', type: 'WIND', capacityMW: 100, currentGenerationMW: 61.3, forecastGenerationMW: 66.7, status: 'WARNING', availabilityPct: 94.6, currentExportMW: 58.1, gridExportLimitMW: 90, connectionExportCapacityMW: 90, gridImportAllowed: false, gridImportLimitMW: 0, connectionImportCapacityMW: 0, currentImportMW: 0, maximumPurchaseMW: 0, batteryCapacityMWh: 120, batterySocPct: 69, batterySohPct: 95, batteryPowerMW: 4, batteryMaxPowerMW: 24, batterySafeChargePct: 95, reservePct: 31, outputLimitPct: 100, batteryMode: 'AUTO', operatingMode: 'AI_ASSISTED', revenueToday: 0, curtailmentMW: 1.4, equipment: { online: 27, total: 30 }, weather: { windSpeedMps: 6.1, windDirectionDeg: 219, windGustMps: 10.2, temperatureC: 17.8, airDensityKgM3: 1.22, turbineAvailabilityPct: 94.6, turbinesOnline: 27, turbinesTotal: 30, capacityFactorPct: 61 } },
]

const RANGE_HOURS = { '12h': 12, '24h': 24, '72h': 72 }
const INTERVAL_MINUTES = { '15m': 15, '1h': 60 }

const seriesFor = (farm, { range = '24h', interval = '15m', now = Date.now() } = {}) => {
  const rangeHours = RANGE_HOURS[range]
  const intervalMinutes = INTERVAL_MINUTES[interval]
  if (!rangeHours) throw new TypeError(`range must be one of ${Object.keys(RANGE_HOURS).join(', ')}`)
  if (!intervalMinutes) throw new TypeError(`interval must be one of ${Object.keys(INTERVAL_MINUTES).join(', ')}`)
  const count = Math.floor(rangeHours * 60 / intervalMinutes) + 1
  return Array.from({ length: count }, (_, index) => {
    const timestamp = new Date(now - (count - 1 - index) * intervalMinutes * 60000)
    const localHour = (timestamp.getUTCHours() + 5.5) % 24
    const solarFactor = Math.max(0, Math.sin(((localHour - 6) / 12) * Math.PI))
    const windFactor = 0.72 + Math.sin((timestamp.getTime() / 3600000 + farm.farmId.length) * 0.45) * 0.08
    const factor = farm.type === 'SOLAR' ? solarFactor : windFactor
    const actualMW = Number(Math.min(farm.capacityMW, farm.currentGenerationMW * factor).toFixed(1))
    const forecastBias = 1 + Math.sin(index * 0.37 + farm.farmId.length) * 0.035
    return { timestamp: timestamp.toISOString(), actualMW, forecastMW: Number((actualMW * forecastBias).toFixed(1)) }
  })
}

const market = { agent: 'MARKET', agentRunId: 'market-run-fallback', status: 'COMPLETED', generatedAt: null, source: 'MOCK_FALLBACK', currentPricePerMWh: 7420, forecasts: [{ horizon: '1h', predictedPricePerMWh: 7580, confidencePct: 94 }, { horizon: '6h', predictedPricePerMWh: 8290, confidencePct: 87 }, { horizon: '24h', predictedPricePerMWh: 7960, confidencePct: 76 }], trend: 'RISING', expectedPeakPricePerMWh: 8640, expectedPeakAt: null, marketStatus: 'FAVORABLE', riskLevel: 'MEDIUM', newsImpact: 'LOW', confidencePct: 87, drivers: ['Simulated evening demand is increasing.', 'Simulated transmission capacity remains constrained.'] }

const ALERT_CONFIG = { gridWarningRatio: 0.75, gridCriticalRatio: 0.95, availabilityWarningPct: 97, batteryMarginWarningPct: 10 }
const alertAcknowledgements = new Map()

function alertsFor(currentFarms = farms, generatedAt = new Date().toISOString()) {
  const results = []
  for (const farm of currentFarms) {
    const exportRatio = farm.gridExportLimitMW ? farm.currentExportMW / farm.gridExportLimitMW : 0
    if (exportRatio >= ALERT_CONFIG.gridWarningRatio) results.push({ id: `grid-${farm.farmId}`, severity: exportRatio >= ALERT_CONFIG.gridCriticalRatio ? 'critical' : 'warning', tab: 'Grid', title: 'Grid export headroom is limited', farm: farm.name, generatedAt, description: `Export is ${farm.currentExportMW} MW against the current ${farm.gridExportLimitMW} MW limit.` })
    if (farm.availabilityPct < ALERT_CONFIG.availabilityWarningPct) results.push({ id: `equipment-${farm.farmId}`, severity: 'warning', tab: 'Operations', title: 'Equipment availability below threshold', farm: farm.name, generatedAt, description: `${farm.equipment.online} of ${farm.equipment.total} units are online; availability is ${farm.availabilityPct}%.` })
    const reserveMargin = farm.batterySocPct - farm.reservePct
    if (reserveMargin <= ALERT_CONFIG.batteryMarginWarningPct) results.push({ id: `battery-${farm.farmId}`, severity: 'warning', tab: 'Operations', title: 'Battery reserve margin is tight', farm: farm.name, generatedAt, description: `Battery SOC is ${farm.batterySocPct}% with a ${farm.reservePct}% reserve target.` })
  }
  return results.map(alert => ({ ...alert, source: 'SIMULATED', acknowledged: alertAcknowledgements.get(alert.id) || false }))
}

function setAlertAcknowledged(id, acknowledged) {
  alertAcknowledgements.set(String(id), acknowledged)
}

const PERFORMANCE_FACTORS = { today: 1, '7d': 6.82, '30d': 28.7, ytd: 268 }
function performanceFor(currentFarms = farms, range = 'today', farmId, revenueByFarm = {}) {
  const factor = PERFORMANCE_FACTORS[range]
  if (!factor) throw new TypeError(`range must be one of ${Object.keys(PERFORMANCE_FACTORS).join(', ')}`)
  const selected = farmId ? currentFarms.filter(farm => farm.farmId === farmId) : currentFarms
  if (!selected.length) return null
  const hours = 12.4 * factor
  const solarEnergyMWh = selected.filter(farm => farm.type === 'SOLAR').reduce((sum, farm) => sum + farm.currentGenerationMW * hours, 0)
  const windEnergyMWh = selected.filter(farm => farm.type === 'WIND').reduce((sum, farm) => sum + farm.currentGenerationMW * hours, 0)
  const energy = solarEnergyMWh + windEnergyMWh
  const expected = selected.reduce((sum, farm) => sum + farm.forecastGenerationMW * hours, 0)
  const capacity = selected.reduce((sum, farm) => sum + farm.capacityMW, 0)
  const availability = selected.reduce((sum, farm) => sum + farm.availabilityPct * farm.capacityMW, 0) / capacity
  const curtailed = selected.reduce((sum, farm) => sum + farm.curtailmentMW * hours, 0)
  const batteryDischargeMWh = selected.reduce((sum, farm) => sum + Math.max(0, -farm.batteryPowerMW) * hours, 0)
  const revenue = selected.reduce((sum, farm) => sum + Number(revenueByFarm[farm.farmId] || 0), 0)
  return { source: 'SIMULATED', generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), range, farmId: farmId || null, energy: Number(energy.toFixed(1)), expected: Number(expected.toFixed(1)), capacityFactor: Number((energy / Math.max(capacity * hours, 1) * 100).toFixed(1)), availability: Number(availability.toFixed(1)), revenue: Number(revenue.toFixed(2)), revenueSource: 'PERSISTED_SIMULATED_FINANCIAL_LEDGER', curtailed: Number(curtailed.toFixed(1)), accuracy: null, solarEnergyMWh: Number(solarEnergyMWh.toFixed(1)), windEnergyMWh: Number(windEnergyMWh.toFixed(1)), batteryDischargeMWh: Number(batteryDischargeMWh.toFixed(1)), lostRevenue: null, lossReason: 'UNAVAILABLE_WITHOUT_INTERVAL_PRICE_AND_CURTAILMENT_LEDGER', farms: selected.map(farm => ({ farmId: farm.farmId, name: farm.name, type: farm.type, energyMWh: Number((farm.currentGenerationMW * hours).toFixed(1)), capacityFactorPct: Number((farm.currentGenerationMW / farm.capacityMW * 100).toFixed(1)), availabilityPct: farm.availabilityPct, forecastAccuracyPct: null, revenue: Number((revenueByFarm[farm.farmId] || 0).toFixed(2)), status: farm.status })) }
}

module.exports = { farms, seriesFor, market, alertsFor, setAlertAcknowledged, performanceFor, RANGE_HOURS, INTERVAL_MINUTES, ALERT_CONFIG }
