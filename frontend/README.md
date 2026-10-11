# Gridline AI dashboard

The React/Vite dashboard consumes only backend APIs. It does not read local mock
files or call Python directly.

Pages include Fleet Overview, 3D Farm Explorer, Farm Detail, Generation Outlook,
Performance, Operations, Alerts, and the Agent Command Center. The Command
Center displays the real 72-hour market trajectory, evaluated portfolio
strategies, selected first-hour allocation, human approval controls, persisted
workflow components/events, decisions, and simulated ledger entries.

Truthfulness conventions:

- recent generation is labeled simulated history;
- future generation is weather-driven engineering simulation;
- demo prices are labeled deterministic fictional market simulation;
- confidence and uncertainty are `N/A` when not calibrated;
- projected economics remain separate from applied ledger value;
- missing configuration is shown instead of substituted zeros.

Start the backend first, explicitly activating the demo profile if desired:

```bash
cd ../backend
npm run config:activate-integrated-demo
npm start
```

Then:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite proxy sends `/api/*` to
`http://localhost:3000`.

Quality checks:

```bash
npm run lint
npm run build
```
