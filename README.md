# Gridline AI

Gridline AI is a multi-farm renewable-energy optimization simulation. It uses
future Open-Meteo weather, fictional farm equipment, explicitly configured
fictional electricity prices, a fleet-wide MILP, bounded OpenAI reasoning,
human approval, and durable simulated accounting.

It does **not** control real infrastructure. Farm telemetry, equipment,
economics, market scenarios, recommendations, and execution are simulations.

## Architecture

```text
Open-Meteo weather → 72-hour generation engineering simulation ─┐
                                                                ├→ Fleet MILP
Explicit 288-block fictional market simulation ─────────────────┘      |
                              |                                        v
                              └→ AI Market Intelligence       Decision Agent
                                                                       |
                                                                Human approval
                                                                       |
                                                      First-hour simulated apply
                                                                       |
                                                      SQLite state + finance ledger
```

- Generation: deterministic solar/wind engineering calculations; no fabricated
  confidence or accuracy.
- Market: 288 native 15-minute INR/MWh prices and exactly 72 aligned hourly
  values. Demo prices use `DETERMINISTIC_MARKET_SIMULATION` provenance.
- Historical market mode: operator-controlled CSV ingestion exists, but trained
  forecasting remains `INCOMPLETE_DATA` without a permitted dataset/artifact.
- Market Intelligence: qualitative OpenAI-compatible analysis only; it cannot
  create numerical prices or operational decisions.
- Optimizer: `javascript-lp-solver` MILP over four farms and 72 hours, including
  energy balance, batteries, reserve, per-farm limits, shared limits, and costs.
- Decision Agent: at most three optimizer scenario calls, bounded tokens/time/
  retries/cost admission, structured validation, and no state-mutation tool.
- Execution: human approval applies only the first hour transactionally and
  idempotently. The remaining 71 hours stay projected.
- Command Center: real SQLite-backed workflows, components, decisions, tool
  calls, approvals, state changes, and simulated financial records.

## Requirements

- Node.js 24 or newer.
- Python 3 with dependencies from `market_model/requirements.txt` for optional
  Market Intelligence and the legacy developer model endpoint.

## Setup

```bash
cp .env.example .env

cd backend
npm install
npm run config:activate-integrated-demo
npm start
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

Normal startup is fail-closed: it does not activate fictional market prices or
unknown economics. `config:activate-integrated-demo` explicitly creates a new
immutable `USER_CONFIGURED_SIMULATION` version containing Phase 2A equipment,
Normal Market, economics, optimizer strategies, and AI limits. Review
`backend/config/examples/integrated_demo_profile.js` before activation.

Optional provider settings:

```dotenv
MARKET_AI_API_KEY=
MARKET_AI_BASE_URL=https://openrouter.ai/api/v1
MARKET_AI_MODEL=gpt-5-mini

DECISION_AI_API_KEY=
DECISION_AI_BASE_URL=https://openrouter.ai/api/v1
DECISION_AI_MODEL=gpt-5-mini
DECISION_AI_ESTIMATED_REQUEST_COST_MINOR_UNITS=
```

The request-cost estimate is operator-supplied because the application does not
invent provider pricing. Without credentials or a cost estimate, the explicitly
configured deterministic decision fallback is used and labeled `DEGRADED`.

## Historical market import

No historical exchange dataset ships with the repository. To import a permitted
operator export:

```bash
cd backend
npm run market:import -- --file /approved/path/prices.csv --manifest /approved/path/manifest.json
```

See `backend/config/market/README.md`. Imports preserve checksums, raw source,
metadata, revisions, UTC/IST semantics, gaps, and provenance. Importing data does
not claim that a trained model exists.

## Main API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/farms/:farmId/forecast` | 72 aligned hourly generation intervals |
| `GET /api/market/forecast` | 288/72 configured market trajectory and optional intelligence |
| `GET /api/market/data-readiness` | Imported dataset quality/readiness |
| `GET /api/market/historical-forecast-readiness` | Explicit historical model gate and metrics status |
| `GET /api/optimizer/recommendations?strategy=BALANCED` | Validated 72-hour portfolio MILP |
| `GET /api/decision/recommendation` | Bounded portfolio recommendation |
| `POST /api/decision/recommendation/:id/action` | `ACCEPT` or `DISMISS`; first hour only |
| `GET /api/workflows` | Durable workflow history |
| `GET /api/workflows/:id` | Component and event trace |
| `GET /api/decisions` | Durable recommendation/approval history |
| `GET /api/financial-ledger` | Applied simulated interval accounting |
| `GET /api/configuration` | Active version and readiness |

Farm-specific legacy optimizer/decision query parameters remain for compatibility
but are not used by the Command Center or primary operational workflow.

## Data truthfulness

- `null`/`UNAVAILABLE` means unknown; explicit zero remains zero.
- The 92% charge/discharge efficiencies remain
  `LEGACY_CODE_ASSUMPTION`, not verified equipment data.
- Revenue cards derive only from `simulated_financial_ledger` entries.
- Projected 72-hour value is separate from applied first-hour accounting.
- No historical prices, accuracy, or calibrated uncertainty are fabricated.
- The legacy crawler/site and old LLM-price adapter remain compatibility code;
  they do not feed the primary portfolio workflow.

## Verification

```bash
cd backend
npm test

cd ../frontend
npm run lint
npm run build

cd ..
python3 -m py_compile market_model/main.py market_model/agent.py market_model/ai/openai_provider.py
git diff --check
```

See [ARCHITECTURE_INVESTIGATION.md](ARCHITECTURE_INVESTIGATION.md) for the
implementation report, exact verification results, and remaining limitations.
