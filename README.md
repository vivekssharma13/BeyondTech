# BeyondTech Renewable Energy Platform

Clean monorepo for the renewable-energy forecasting and operations dashboard.

## Structure

```text
backend/   Node HTTP API, backend demo data, and API package
frontend/  React/Vite operations dashboard
model/     Python training/inference code, source data, model artifacts
```

## Run Locally

Terminal 1, start the backend:

```bash
cd backend
npm start
```

Terminal 2, start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

The Vite proxy sends `/api/*` to `http://localhost:3000`. All dashboard data is fetched through backend HTTP endpoints. Backend demo responses live in `backend/api_dashboard_data.js`; the frontend does not use local dashboard mock data.

## Model Workflow

The model environment is the root `.venv`:

```bash
source .venv/bin/activate
python -m pip install pandas scikit-learn joblib
cd model
python solar_wind_pipeline.py
python solar_wind_pipeline.py validate
```

The backend calls `model/predict.py`, which loads the trained solar and wind models and returns point predictions, split-conformal intervals, confidence, weather fallback metadata, and physical zero-output rules.

## Validation

```bash
cd frontend
npm run lint
npm run build
```

Backend routes include `/api/health`, `/api/fleet`, `/api/farms`, `/api/farms/:farmId`, `/api/farms/:farmId/generation`, `/api/farms/:farmId/forecast`, `/api/market/forecast`, `/api/optimizer/recommendations`, `/api/alerts`, `/api/agent-runs`, `/api/performance`, `/api/freshness`, and `/api/predict`.