# BeyondTech Renewable Energy Platform

BeyondTech is a hackathon control-room application for a simulated fleet of
solar and wind farms. It combines generation forecasting, market analysis,
physical feasibility rules, and an explainable BUY/SELL/HOLD decision.

The application does **not** control real infrastructure. Current farm
telemetry, operational state, alerts, and performance data are deterministic
simulations and are labeled accordingly in the API and dashboard.

![Renewable Energy AI Platform Architecture](https://github.com/user-attachments/assets/06bed673-778e-4fad-a29e-65190ec2ce6a)

## Architecture

The repository contains exactly four agents:

1. **Generation Forecast Agent** — runs the existing Python solar and wind
   models for 1h, 6h, 24h, 48h, and 72h forecasts.
2. **Market Agent** — analyzes scraped market observations and returns price
   forecasts, risks, and drivers. It never selects an operational action.
3. **Optimizer Agent** — applies battery, import, export, reserve, availability,
   and output constraints to produce feasible BUY, SELL, and HOLD quantities.
4. **Decision Agent** — deterministically scores the feasible candidates and
   chooses the final action. The selected quantity always comes from the
   Optimizer.

```text
Generation Forecast ──┐
                      ├──> Optimizer ──> Candidate strategies ──> Decision Agent
Market Forecast ──────┘                                      BUY / SELL / HOLD
```

Generation and market results are cached in memory for the current 15-minute
bucket. Model or provider failures return explicitly labeled backend fallback
data. Accepted decisions update in-memory simulation state only.

## Data source labels

| Label | Meaning |
| --- | --- |
| `LIVE` | Current external data. No existing endpoint currently qualifies. |
| `MODEL` | Model inference using current inputs. Reserved for future use. |
| `MODEL_WITH_HISTORICAL_INPUTS` | Real model inference using the checked-in historical weather dataset. |
| `MARKET_AGENT` | Successful analysis by the configured market model provider. |
| `SIMULATED` | Deterministic hackathon scenario or operational state. |
| `MOCK_FALLBACK` | Backend-owned fallback returned after a model or agent failure. |

## Repository structure

```text
backend/       Node.js HTTP API, agent services, simulation state, and tests
frontend/      React/Vite operations dashboard
model/         Existing Python training and prediction pipeline
market_model/  Market crawler, simulated source site, and Market Agent
```

The Node backend is the application API. It invokes Python through service
adapters; the React frontend does not invoke Python or load mock files directly.

## Local setup

### 1. Python dependencies

From the repository root:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install pandas numpy scikit-learn joblib openai python-dotenv requests beautifulsoup4 lxml selenium pypdf feedparser
```

### 2. Environment configuration

```bash
cp .env.example .env
```

The market provider is optional. Without a key, the application continues with
`MOCK_FALLBACK` market data and `/api/health` reports
`CONFIGURATION_REQUIRED`.

```dotenv
DECISION_AGENT_MODE=RULE_BASED
DECISION_AI_API_KEY=
DECISION_AI_BASE_URL=https://openrouter.ai/api/v1
DECISION_AI_MODEL=
```

`MARKET_AI_*` and standard `OPENAI_*` names remain supported for compatibility.
Never commit credentials.

### 3. Start the backend

```bash
cd backend
npm install
npm start
```

The backend runs at `http://localhost:3000`.

### 4. Start the frontend

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the backend.

## Decision model

The Decision Agent uses normalized `0–100` rule scores. These scores are
explainable hackathon heuristics, not calibrated probabilities.

| Candidate | Signals and default weights |
| --- | --- |
| BUY | Future price upside 30%, battery capacity 20%, generation shortfall 20%, import headroom 15%, forecast confidence 15% |
| SELL | Current-price opportunity 30%, reserve margin 20%, export headroom 20%, generation surplus 15%, forecast confidence 15% |
| HOLD | Forecast uncertainty 30%, weak price spread 25%, tight reserve 20%, conflicting signals 15%, candidate closeness 10% |

Infeasible candidates are removed before scoring. HOLD is preferred when BUY
and SELL scores are close, forecast confidence is low, or market risk is high.
Weights and thresholds are defined in
`backend/services/decision_service.js`.

## API reference

| Endpoint | Method | Primary source | Purpose |
| --- | --- | --- | --- |
| `/api/health` | GET | Runtime readiness | Python, artifact, provider, and agent status |
| `/api/fleet` | GET | `SIMULATED` | Fleet generation, grid, storage, revenue, and alert summary |
| `/api/farms` | GET | `SIMULATED` | All farm state |
| `/api/farms/:farmId` | GET | `SIMULATED` | One farm |
| `/api/farms/:farmId/generation` | GET | `SIMULATED` | Generation history; supports `range=12h/24h/72h` and `interval=15m/1h` |
| `/api/farms/:farmId/forecast` | GET | Model or fallback | Cached generation forecast |
| `/api/market/forecast` | GET | Market Agent or fallback | Market-only price intelligence |
| `/api/optimizer/recommendations` | GET | `SIMULATED` rules | Feasible candidates; optional `farmId` |
| `/api/decision/recommendation` | GET | `SIMULATED` rules | Final decision; optional `farmId` |
| `/api/decision/recommendation/:decisionId/action` | POST | `SIMULATED` | Idempotent `ACCEPT` or `DISMISS` action |
| `/api/farms/:farmId/operations` | GET, PATCH | `SIMULATED` | Read or update validated operating settings |
| `/api/alerts` | GET | `SIMULATED` | State-derived alerts |
| `/api/alerts/:alertId` | PATCH | In-memory state | Acknowledge or reopen an alert |
| `/api/performance` | GET | `SIMULATED` | Supports `range=today/7d/30d/ytd` and optional `farmId` |
| `/api/agent-runs` | GET | Runtime history | Recent agent executions |
| `/api/activity` | GET | Runtime history | Agent and operator activity |
| `/api/freshness` | GET | Mixed | Source timestamps and next-run metadata |
| `/api/predict` | POST | Model | Low-level developer prediction endpoint |

Forecast, market, optimizer, and decision GET routes accept `?refresh=true`
for development. Normal clients should rely on the cache.

## Important limitations

- Farm telemetry, weather, equipment, grid, storage, alerts, performance, and
  financial state are simulated.
- Generation inference uses historical or nearest weather observations rather
  than a live weather provider.
- Model output is scaled from a normalized 0–1000 reference plant to each
  farm's available capacity.
- Wind training targets are synthetic, and some solar targets are derived from
  radiation data.
- Runtime history, caches, alert acknowledgements, decisions, and operational
  mutations are process-local and reset when the backend restarts.
- Forecast accuracy is unavailable until realized generation outcomes are
  persisted and joined to prior forecasts.
- The checked-in market website and crawler output are simulated inputs.

See [PROJECT_ISSUES.txt](PROJECT_ISSUES.txt) for the detailed stabilization
audit and remaining issues. See [market_model/README.md](market_model/README.md)
for the market crawler and provider workflow.

## Tests

```bash
cd backend
npm test

cd ../frontend
npm run lint
npm run build
```

To validate the forecasting pipeline separately:

```bash
cd model
python solar_wind_pipeline.py validate
```

## Security and safety

- Keep API keys and `.env` files out of version control.
- Treat all accepted decisions as simulation events, never physical dispatch.
- Real-world execution would require authenticated control interfaces,
  authorization, audit persistence, safety interlocks, and regulatory checks.
