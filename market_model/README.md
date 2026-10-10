# Market Agent

This is the existing market-intelligence component of the renewable-energy
platform. It turns raw scraped observations into current and forecast market
conditions. It does not select BUY, SELL, or HOLD, calculate a dispatch
quantity, or recommend battery actions; those responsibilities belong to the
Optimizer and Decision Agents.

## Flow

```text
energy_intelligence/ simulated site
              |
              v
script/webscrapping.py
              |
              v
output/simulatedWorld.json
              |
              v
ScraperOutputService -> MarketAgent -> OpenAIProvider
              |
              v
validated market-only JSON on stdout
              |
              v
backend/services/market_service.js (15-minute cache + fallback)
```

`MarketAgent.run()` loads the crawler artifact using a path based on the source
file location, then submits it to the configured model. The provider uses a
strict JSON schema and validates the parsed response. Machine invocation writes
one JSON object to stdout; failures are logged to stderr and exit non-zero so
the Node adapter can return its backend-owned `MOCK_FALLBACK` response.

## Output contract

```json
{
  "currentPricePerMWh": 7420,
  "forecasts": [
    { "horizon": "1h", "predictedPricePerMWh": 7580, "confidencePct": 94 },
    { "horizon": "6h", "predictedPricePerMWh": 8290, "confidencePct": 87 },
    { "horizon": "24h", "predictedPricePerMWh": 7960, "confidencePct": 76 }
  ],
  "trend": "RISING",
  "expectedPeakPricePerMWh": 8640,
  "expectedPeakAt": "2026-10-09T15:30:00Z",
  "marketStatus": "FAVORABLE",
  "riskLevel": "MEDIUM",
  "newsImpact": "LOW",
  "confidencePct": 87,
  "drivers": ["Evening demand is increasing."]
}
```

Confidence values use the integer `0–100` percentage scale. The Node adapter
adds agent metadata such as `agentRunId`, `generatedAt`, and `source`.

## Folder map

| Path | Purpose |
| --- | --- |
| `main.py` | Machine-readable CLI entry point. |
| `agent.py` | Loads observations and delegates market analysis. |
| `ai/provider.py` | Minimal provider interface. |
| `ai/openai_provider.py` | Configuration, prompt, structured output, and validation. |
| `services/scraper_output_service.py` | Loads the crawler JSON by source-relative path. |
| `script/webscrapping.py` | Selenium crawler, relevance filter, and field extractor. |
| `energy_intelligence/` | Static simulated market, grid, and article website. |
| `output/simulatedWorld.json` | Latest crawler output. |
| `services/{price,demand,battery,news}_service.py` | Older prototypes not used by `MarketAgent`. |

## Configuration

The provider prefers the repository's Decision AI variables and preserves the
older Market Agent and standard OpenAI names for compatibility:

```dotenv
DECISION_AI_API_KEY=
DECISION_AI_BASE_URL=https://openrouter.ai/api/v1
DECISION_AI_MODEL=
```

Fallback names are `MARKET_AI_*`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL`. An
OpenRouter-compatible endpoint can be selected without changing business logic:

```dotenv
DECISION_AI_BASE_URL=https://openrouter.ai/api/v1
```

Never commit keys.

## Run the simulated workflow

Install dependencies in the repository virtual environment. Chrome or Chromium
and a compatible ChromeDriver are also required only when rerunning the crawler.

```bash
python -m pip install openai python-dotenv requests beautifulsoup4 lxml selenium pypdf feedparser
```

Start the simulated source:

```bash
cd market_model
python -m http.server 8000 --directory energy_intelligence
```

In another terminal, regenerate the crawler artifact:

```bash
cd market_model
python script/webscrapping.py
```

Run one market analysis from any working directory:

```bash
python market_model/main.py
```

The normal application flow is `GET /api/market/forecast` through the Node
backend, not direct invocation from React.

## Model run log

Every attempted AI call is appended to `output/model_runs.jsonl`. Each JSON
Lines record contains the UTC timestamp, run ID, selected model and base URL,
duration, complete scraper input, validated model output, and sanitized error
details. API keys are never written to the log.

Pretty-print the latest run with:

```bash
tail -n 1 market_model/output/model_runs.jsonl | python -m json.tool
```

## Implementation notes

- The checked-in website and observations are simulated, not live market data.
- The crawler currently targets `http://localhost:8000`; commented entries show
  the intended direction for approved external sources.
- Duplicate observations are removed before prompting. Raw page text is still
  preserved alongside extracted numeric fields and can increase prompt size.
- A malformed, refused, or unavailable model response is intentionally treated
  as an agent failure. The backend owns fallback policy and labels it
  `MOCK_FALLBACK`.
- New providers can implement `AiProvider.analyze()` and be injected into
  `MarketAgent`; they must preserve the market-only output boundary.
