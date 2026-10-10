# BeyondTech — Renewable Energy Intelligence Platform

An AI-powered renewable energy platform that combines solar and wind generation forecasting, market intelligence, and optimization recommendations to support smarter energy operations.

The platform consists of three agents — **Forecast, Market, and Optimization** — backed by a Python forecasting pipeline, a Node.js API, and a React operations dashboard.

## Architecture

<img width="1536" height="1024" alt="Renewable Energy AI Platform Architecture" src="https://github.com/user-attachments/assets/06bed673-778e-4fad-a29e-65190ec2ce6a" />

The platform follows this workflow:

1. **Collect:** Gather historical generation data, weather information, electricity prices, demand, grid conditions, battery information, and external news.
2. **Forecast:** Predict solar and wind generation across multiple time horizons using trained machine-learning models.
3. **Analyze:** Interpret market conditions and relevant external events.
4. **Optimize:** Combine forecast and market outputs to recommend whether to buy, sell, or hold energy.
5. **Apply confidence gate:** Compare decision confidence against a configured threshold. Lower-confidence decisions require operator review.
6. **Visualize:** Deliver forecasts, recommendations, alerts, and farm-level information through the dashboard.

## Key Components

| Component | Responsibility | Technology |
|---|---|---|
| Forecast Agent | Predict solar and wind generation and quantify uncertainty | Python, scikit-learn |
| Market Agent | Analyze electricity prices, demand, grid constraints, battery conditions, and external news | Python, OpenAI API, web scraping |
| Optimization Agent | Combine forecast and market intelligence to generate recommendations | Decision and optimization logic |
| Backend API | Expose predictions, farm information, alerts, and recommendations | Node.js |
| Operations Dashboard | Display fleet status, farm details, historical statistics, forecasts, and decisions | React, Vite |

## Forecasting Model

The forecasting pipeline uses **eight years of historical solar and wind data** to train models for renewable generation prediction.

Supported forecast horizons:

- 15 minutes and 1 hour — highest priority
- 6 hours
- 24 hours
- 48 hours
- 72 hours

The inference pipeline provides point predictions, split-conformal prediction intervals, confidence information, weather fallback metadata, and physical zero-output rules.

## Market Intelligence

The Market Agent collects and interprets relevant external information, including:

- Electricity prices and price movements
- Electricity demand and consumption
- Grid capacity and transmission constraints
- Battery state of charge and storage requirements
- Weather events, including cyclones and extreme conditions
- Relevant external news and market developments

Government websites provide controlled market scenarios and articles. The `scraper` extracts relevant observations into structured output, which the Market Agent analyzes.

## Optimization and Decision-Making

The Optimization Agent combines generation forecasts with market intelligence to produce **BUY, SELL, or HOLD** recommendations.

Each recommendation can include the proposed action, energy quantity where supported, confidence, and rationale.

A configurable confidence threshold determines whether a recommendation is eligible for autonomous action or requires human review. Real-world execution must also satisfy operating constraints, authorization, and safety checks.

## Run Locally

### 1. Start the backend

```bash
cd backend
npm install
npm start
```

The backend runs at `http://localhost:3000`.

### 2. Start the frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` or the URL printed by Vite. The Vite proxy forwards `/api/*` requests to the backend.

### 3. Set up the Python environment

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install pandas scikit-learn joblib
```

Install any additional dependencies required by the model and Market Agent.

### 4. Validate the model

```bash
cd model
python solar_wind_pipeline.py
python solar_wind_pipeline.py validate
```

### 5. Configure the Market Agent

Create a local `.env` file and supply your own OpenAI API key if required by the current implementation.

Run the simulated website, scraper, and Market Agent using the commands documented in their respective scripts.

## API Endpoints

| Endpoint | Purpose |
|---|---|
| `/api/health` | Backend health |
| `/api/fleet` | Fleet overview |
| `/api/farms` | Available farms |
| `/api/farms/:farmId` | Farm details |
| `/api/farms/:farmId/generation` | Farm generation |
| `/api/farms/:farmId/forecast` | Farm forecasts |
| `/api/market/forecast` | Market forecast |
| `/api/optimizer/recommendations` | Optimization recommendations |
| `/api/alerts` | Operational alerts |
| `/api/agent-runs` | Agent execution information |
| `/api/performance` | Performance information |
| `/api/freshness` | Data freshness |
| `/api/predict` | Prediction interface |

## Validation

```bash
cd frontend
npm run lint
npm run build
```

Validate the forecasting pipeline with:

```bash
cd model
python solar_wind_pipeline.py validate
```

## Security and Data Handling

- Never commit `.env`, API keys, or other secrets.
- Exclude virtual environments, `node_modules/`, `__pycache__/`, and temporary files.
- Keep credentials in environment variables.
- Treat simulated market observations separately from verified live data.
- Require appropriate safety checks and authorization before executing real-world energy transactions.

## Expected Impact

BeyondTech aims to improve renewable generation visibility, anticipate market and grid changes, support battery planning, and enable more transparent, confidence-aware energy decisions.

