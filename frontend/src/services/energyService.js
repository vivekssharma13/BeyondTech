const apiBase = import.meta.env.VITE_API_BASE_URL || '/api'

async function apiGet(path) {
  const response = await fetch(`${apiBase}${path}`)
  const result = await response.json()
  if (!response.ok || result.error) throw new Error(result.error?.message || result.error || `Request failed: ${path}`)
  return result
}

function normalizeFarm(farm) {
  const weather = farm.type === 'SOLAR'
    ? { ghi: farm.weather.ghiWm2, dni: farm.weather.dniWm2, dhi: farm.weather.dhiWm2, sunshine: farm.weather.sunshinePct, cloud: farm.weather.cloudCoverPct, temp: farm.weather.temperatureC, module: farm.weather.moduleTemperatureC, uv: farm.weather.uvIndex, visibility: farm.weather.visibilityKm, precip: farm.weather.precipitationProbabilityPct }
    : { wind: farm.weather.windSpeedMps, direction: farm.weather.windDirectionDeg, gust: farm.weather.windGustMps, air: farm.weather.temperatureC, density: farm.weather.airDensityKgM3, turbineAvailability: farm.weather.turbineAvailabilityPct, online: farm.weather.turbinesOnline, total: farm.weather.turbinesTotal, capacityFactor: farm.weather.capacityFactorPct }
  return { ...farm, id: farm.farmId, type: farm.type.toLowerCase(), status: farm.status.toLowerCase(), weather }
}

async function getFarms() {
  const result = await apiGet('/farms')
  return result.farms.map(normalizeFarm)
}

async function getForecast(farmId = 'sunpeak') {
  const [forecast, generation] = await Promise.all([apiGet(`/farms/${farmId}/forecast`), apiGet(`/farms/${farmId}/generation?range=24h&interval=15m`)])
  return {
    horizons: forecast.horizons.map((item) => ({ label: `NEXT ${item.horizon.toUpperCase()}`, value: item.predictedGenerationMW, change: 0, confidence: item.confidencePct, range: `${item.lowerBoundMW}–${item.upperBoundMW} MW` })),
    series: generation.data.map((item) => ({ label: item.timestamp.slice(11, 16), actual: item.actualMW, forecast: item.forecastMW, low: item.forecastMW, high: item.forecastMW })),
    metadata: forecast,
  }
}

async function getModelPrediction(date = '2020-05-15T12:00') {
  const response = await fetch(`${apiBase}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date }) })
  const result = await response.json()
  if (!response.ok || result.error) throw new Error(result.error?.message || result.error || 'Model API unavailable')
  return result
}

export const energyService = {
  getFleet: () => apiGet('/fleet'),
  getFarms,
  getFarm: (farmId) => apiGet(`/farms/${farmId}`).then(normalizeFarm),
  getGeneration: (farmId, range = '24h') => apiGet(`/farms/${farmId}/generation?range=${range}&interval=15m`),
  getForecast,
  getPerformance: () => apiGet('/performance'),
  getAlerts: () => apiGet('/alerts').then((result) => result.alerts),
  getAgentRuns: () => apiGet('/agent-runs').then((result) => result.runs),
  getMarketForecast: () => apiGet('/market/forecast').then((data) => ({ ...data, current: data.currentPricePerMWh, oneHour: data.forecasts.find((item) => item.horizon === '1h').predictedPricePerMWh, sixHour: data.forecasts.find((item) => item.horizon === '6h').predictedPricePerMWh, day: data.forecasts.find((item) => item.horizon === '24h').predictedPricePerMWh, peak: data.expectedPeakPricePerMWh, peakTime: data.expectedPeakAt.slice(11, 16), confidence: data.forecasts[0].confidencePct })),
  getOptimizerRecommendations: (farmId) => apiGet(`/optimizer/recommendations${farmId ? `?farmId=${farmId}` : ''}`),
  getFreshness: () => apiGet('/freshness'),
  getModelPrediction,
}
