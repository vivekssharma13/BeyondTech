"""Structured, append-only audit logging for Market Agent model calls."""

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock


LOG_FILE = Path(__file__).resolve().parents[1] / "output" / "model_runs.jsonl"
_WRITE_LOCK = Lock()


def write_model_run(*, run_id, status, model, base_url, duration_ms, model_input, model_output=None, error=None):
    """Append one complete model interaction as a JSON Lines record."""
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "agent": "MARKET",
        "status": status,
        "provider": {
            "model": model,
            "baseUrl": base_url or "https://api.openai.com/v1",
        },
        "durationMs": duration_ms,
        "input": model_input,
        "output": model_output,
        "error": error,
    }

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with _WRITE_LOCK:
        with LOG_FILE.open("a", encoding="utf-8") as log_file:
            log_file.write(f"{line}\n")

