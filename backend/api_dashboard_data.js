const farms = [
  { farmId: 'sunpeak', name: 'SunPeak Solar', type: 'SOLAR', capacityMW: 120, currentGenerationMW: 87.4, forecastGenerationMW: 81.2, status: 'HEALTHY', availabilityPct: 99.1, currentExportMW: 82.7, gridExportLimitMW: 108, batteryCapacityMWh: 240, batterySocPct: 71, batterySohPct: 96, batteryPowerMW: -12, reservePct: 24, revenueToday: 284600, curtailmentMW: 4.7, equipment: { online: 47, total: 48 }, weather: { ghiWm2: 612, dniWm2: 488, dhiWm2: 124, sunshinePct: 48, cloudCoverPct: 64, temperatureC: 29.4, moduleTemperatureC: 42.1, uvIndex: 8.2, visibilityKm: 9.4, precipitationProbabilityPct: 12 } },
  { farmId: 'desertbloom', name: 'Desert Bloom Solar', type: 'SOLAR', capacityMW: 80, currentGenerationMW: 58.6, forecastGenerationMW: 51.8, status: 'WARNING', availabilityPct: 96.8, currentExportMW: 55.9, gridExportLimitMW: 72, batteryCapacityMWh: 140, batterySocPct: 64, batterySohPct: 93, batteryPowerMW: -6, reservePct: 19, revenueToday: 198400, curtailmentMW: 6.2, equipment: { online: 31, total: 32 }, weather: { ghiWm2: 554, dniWm2: 431, dhiWm2: 123, sunshinePct: 42, cloudCoverPct: 72, temperatureC: 31.2, moduleTemperatureC: 46.8, uvIndex: 8.8, visibilityKm: 7.8, precipitationProbabilityPct: 18 } },
  { farmId: 'coastal', name: 'Coastal Wind', type: 'WIND', capacityMW: 150, currentGenerationMW: 102.8, forecastGenerationMW: 111.6, status: 'HEALTHY', availabilityPct: 98.4, currentExportMW: 98.5, gridExportLimitMW: 135, batteryCapacityMWh: 200, batterySocPct: 68, batterySohPct: 97, batteryPowerMW: 0, reservePct: 28, revenueToday: 312800, curtailmentMW: 0, equipment: { online: 46, total: 48 }, weather: { windSpeedMps: 8.7, windDirectionDeg: 244, windGustMps: 13.4, temperatureC: 22.1, airDensityKgM3: 1.18, turbineAvailabilityPct: 98.4, turbinesOnline: 46, turbinesTotal: 48, capacityFactorPct: 68 } },
  { farmId: 'highland', name: 'Highland Wind', type: 'WIND', capacityMW: 100, currentGenerationMW: 61.3, forecastGenerationMW: 66.7, status: 'WARNING', availabilityPct: 94.6, currentExportMW: 58.1, gridExportLimitMW: 90, batteryCapacityMWh: 120, batterySocPct: 69, batterySohPct: 95, batteryPowerMW: 4, reservePct: 31, revenueToday: 176900, curtailmentMW: 1.4, equipment: { online: 27, total: 30 }, weather: { windSpeedMps: 6.1, windDirectionDeg: 219, windGustMps: 10.2, temperatureC: 17.8, airDensityKgM3: 1.22, turbineAvailabilityPct: 94.6, turbinesOnline: 27, turbinesTotal: 30, capacityFactorPct: 61 } },
]

const seriesFor = (farm) => Array.from({ length: 25 }, (_, index) => {
  const hour = index - 12
  const solar = farm.type === 'SOLAR' ? Math.max(0, Math.sin(((hour + 8) / 12) * Math.PI)) : 0
  const wind = farm.type === 'WIND' ? 0.68 + Math.sin(index * 0.45) * 0.08 : 0
  const actualMW = Number((farm.currentGenerationMW * (farm.type === 'SOLAR' ? solar : wind)).toFixed(1))
  return { timestamp: `2026-10-08T${String((20 + hour + 24) % 24).padStart(2, '0')}:00:00Z`, actualMW, forecastMW: Number((actualMW * (index > 12 ? 0.94 : 1.02)).toFixed(1)) }
})

const forecastFor = (farm) => {
  const values = [1, 6, 24, 48, 72].map((hours, index) => {
    const predictedGenerationMW = Number((farm.forecastGenerationMW * [1.02, 1, 0.96, 0.98, 1.01][index]).toFixed(1))
    const margin = Number((predictedGenerationMW * [0.03, 0.08, 0.14, 0.2, 0.27][index]).toFixed(1))
    return { horizon: `${hours}h`, predictedGenerationMW, lowerBoundMW: Math.max(0, predictedGenerationMW - margin), upperBoundMW: predictedGenerationMW + margin, confidencePct: [96, 88, 81, 70, 61][index] }
  })
  return { agent: 'GENERATION_FORECAST', agentRunId: 'forecast-run-1842', status: 'COMPLETED', farmId: farm.farmId, generatedAt: '2026-10-08T12:45:00Z', nextRunAt: '2026-10-08T13:00:00Z', horizons: values, drivers: farm.type === 'SOLAR' ? ['Cloud cover is expected to increase.', 'Solar irradiance is expected to decline.'] : ['Wind speed is expected to increase after 22:00.', 'Turbine availability remains stable.'] }
}

const market = { agent: 'MARKET', agentRunId: 'market-run-921', status: 'COMPLETED', generatedAt: '2026-10-08T12:45:00Z', currentPricePerMWh: 7420, forecasts: [{ horizon: '1h', predictedPricePerMWh: 7580, confidencePct: 94 }, { horizon: '6h', predictedPricePerMWh: 8290, confidencePct: 87 }, { horizon: '24h', predictedPricePerMWh: 7960, confidencePct: 76 }], trend: 'RISING', expectedPeakPricePerMWh: 8640, expectedPeakAt: '2026-10-08T15:30:00Z', drivers: ['Evening demand is expected to increase.'] }

const alerts = [
  { id: 1, severity: 'critical', tab: 'Grid', title: 'Grid export approaching 90% capacity', farm: 'Desert Bloom Solar', time: '2 min ago', description: 'Export is at 77.6 MW against an 80 MW operating limit.', acknowledged: false },
  { id: 2, severity: 'warning', tab: 'Forecast', title: 'Forecast deviation exceeded 10%', farm: 'Desert Bloom Solar', time: '18 min ago', description: 'Observed output is 11.8% below the previous agent run.', acknowledged: false },
  { id: 3, severity: 'warning', tab: 'Operations', title: 'Wind turbine availability dropped below threshold', farm: 'Highland Wind', time: '34 min ago', description: 'Three turbines are offline for scheduled inspection.', acknowledged: true },
  { id: 4, severity: 'info', tab: 'Weather', title: 'Cloud front may reduce solar output', farm: 'Fleet', time: '41 min ago', description: 'Cloud cover is forecast to rise across the southern cluster.', acknowledged: false },
]
const agentRuns = [{ time: '20:45', title: 'Forecast updated', detail: '6h generation forecast revised to 292 MW avg.' }, { time: '20:30', title: 'Forecast updated', detail: 'New weather ensemble ingested.' }, { time: '20:15', title: 'Weather anomaly detected', detail: 'Cloud formation faster than prior run.' }]
const performance = { energy: 5248, expected: 5372, capacityFactor: 61.8, availability: 97.5, revenue: 892700, curtailed: 146, accuracy: 91.4 }
const freshness = { telemetry: '18 sec ago', weather: '3 min ago', grid: '42 sec ago' }

module.exports = { farms, seriesFor, forecastFor, market, alerts, agentRuns, performance, freshness }