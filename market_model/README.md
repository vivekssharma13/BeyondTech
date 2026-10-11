# Market Intelligence Agent

This Python component performs qualitative analysis of a numerical market
trajectory supplied by the Node.js backend. It does not create prices,
confidence intervals, or operational decisions.

```text
Configured simulator or approved numerical model
                    |
                    v
72-hour trajectory + provenance
                    |
                    v
MarketAgent -> OpenAIProvider -> qualitative intelligence
```

`main.py` accepts an optional JSON evidence object on stdin. With no stdin it
retains the old scraper-artifact path for developer compatibility. Structured
output contains a summary, trend and risk classifications, timestamped drivers,
opportunities, risks, and limitations. Price, confidence, BUY/SELL/HOLD, and
dispatch fields are rejected.

Configure `MARKET_AI_API_KEY`, `MARKET_AI_BASE_URL`, and `MARKET_AI_MODEL`.
`DECISION_AI_*` and standard `OPENAI_*` names remain compatible fallbacks.
Failures are logged to `output/model_runs.jsonl`; the backend preserves the
valid numerical trajectory and marks only intelligence as degraded.

The checked-in website, crawler, and `output/simulatedWorld.json` are legacy
simulation artifacts. They are not historical exchange observations and are
not used to create the operational price trajectory.
