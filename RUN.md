# Solar and wind pipeline

Run from the project folder after activating `.venv`:

```bash
python -m pip install pandas scikit-learn joblib
python solar_wind_pipeline.py
```

This converts the weather JSON to `solar_wind_training_data.csv`, adds aligned Plant 1 AC output, fills unmatched solar rows from radiation, creates wind output at a reproducible random +/-20% of solar output, normalizes features using training data only, and prints the best solar and wind model.p

The chronological split is 60% training, 20% test for model selection, and 20% final validation.

Run only final validation after training:

```bash
python solar_wind_pipeline.py validate
```

Start the API and HTML app:

```bash
node api_server.js
```

Open http://localhost:3000. Enter only a date/time for automatic weather defaults, or override any available solar and wind weather fields. The API endpoint is `POST /api/predict`.