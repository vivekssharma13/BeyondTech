# Renewable Energy AI Operations Platform

A standalone React/Vite control-room dashboard for a simulated fleet of solar and wind farms. It is API-driven and uses contract-compatible mock data where backend endpoints are pending.

## Architecture

```text
React UI -> energyService -> API endpoint when available
                    -> mock contract fallback when pending
```

The three planned agents are:

- `MARKET`: market price conditions; never makes dispatch decisions.
- `GENERATION_FORECAST`: solar and wind generation forecasts.
- `OPTIMIZER`: simulated operational recommendations; never controls real infrastructure.

All operational controls in this demo are local simulations.

## API Status

| Service | Method | Endpoint | Status |
|---|---|---|---|
| Fleet summary | GET | `/api/fleet` | AVAILABLE · MOCK · PENDING logic |
| Farm list | GET | `/api/farms` | AVAILABLE · MOCK · PENDING logic |
| Farm detail | GET | `/api/farms/:farmId` | AVAILABLE · MOCK · PENDING logic |
| Generation history | GET | `/api/farms/:farmId/generation` | AVAILABLE · MOCK · PENDING logic |
| Generation forecast | GET | `/api/farms/:farmId/forecast` | AVAILABLE · MOCK · PARTIAL logic |
| Market forecast | GET | `/api/market/forecast` | AVAILABLE · MOCK · PENDING logic |
| Optimizer recommendations | GET | `/api/optimizer/recommendations` | AVAILABLE · MOCK · PENDING logic |
| Alerts | GET | `/api/alerts` | AVAILABLE · MOCK · PENDING logic |
| Agent runs | GET | `/api/agent-runs` | AVAILABLE · MOCK · PENDING logic |
| Performance | GET | `/api/performance` | AVAILABLE · MOCK · PENDING logic |
| Data freshness | GET | `/api/freshness` | AVAILABLE · MOCK · PENDING logic |
| Trained solar/wind prediction | POST | `/api/predict` | AVAILABLE |

The available `/api/predict` endpoint is provided by the sibling model project on port `3000`. It returns point predictions, 90% split-conformal bounds, confidence, confidence method, weather fallback metadata, and deterministic no-sun/no-wind rule flags.

Example forecast contract for pending agent APIs:

```json
{
  "farmId": "solar-001",
  "agent": "GENERATION_FORECAST",
  "agentRunId": "forecast-run-1842",
  "status": "COMPLETED",
  "generatedAt": "2026-10-08T12:45:00Z",
  "nextRunAt": "2026-10-08T13:00:00Z",
  "horizons": [
    {
      "horizon": "1h",
      "predictedGenerationMW": 94,
      "lowerBoundMW": 91,
      "upperBoundMW": 97,
      "confidencePct": 96
    }
  ],
  "drivers": ["Cloud cover is expected to increase."]
}
```

Confidence values are supplied by the agent/API. The UI does not calculate them.

## Service Layer

The UI consumes `src/services/energyService.js`, never `src/data/mockData.js` directly. Current service functions include:

```text
getFleet()
getFarm(farmId)
getForecast()
getPerformance()
getAlerts()
getAgentRuns()
getMarketForecast()
getFreshness()
getModelPrediction(date)
```

Every function performs an HTTP request. `getModelPrediction()` calls the existing ML endpoint `/api/predict`; the other functions call backend-hosted demo endpoints. No dashboard page imports or reads `src/data/mockData.js`.

## Page-to-API Mapping

| Page | Dynamic data | Frontend service | Backend endpoint |
|---|---|---|---|
| Fleet Overview | fleet totals, farms, charts, market, model signal | `getFarms`, `getForecast`, `getMarketForecast`, `getModelPrediction` | `/api/farms`, `/api/farms/:farmId/forecast`, `/api/farms/:farmId/generation`, `/api/market/forecast`, `/api/predict` |
| Farm Detail | farm state, weather, generation chart | `getFarms`, `getForecast` | `/api/farms/:farmId`, `/api/farms/:farmId/forecast`, `/api/farms/:farmId/generation` |
| Forecast & AI | horizons, model signal, market | `getForecast`, `getMarketForecast`, `getModelPrediction` | `/api/farms/:farmId/forecast`, `/api/market/forecast`, `/api/predict` |
| Performance | performance KPIs, farms | `getPerformance`, `getFarms` | `/api/performance`, `/api/farms` |
| Operations | farm state, market context | `getFarms`, `getMarketForecast` | `/api/farms`, `/api/market/forecast` |
| Alerts | alert list | `getAlerts` | `/api/alerts` |

All backend demo data currently lives in `api_dashboard_data.js`. Replacing those values with real telemetry, agent logic, or external integrations does not require React component changes.

## Local Development

Start the backend API first:

```bash
cd ../backend
node api_server.js
```

Then start this dashboard:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

The Vite development proxy maps dashboard `/api/*` calls to `http://localhost:3000`. Set `VITE_MODEL_API_URL` to use another API base URL.

Quality checks:

```bash
npm run lint
npm run build
```
