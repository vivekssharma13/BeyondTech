"""Structured, append-only audit logging for Market Agent model calls."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock


LOG_FILE = Path(__file__).resolve().parents[1] / "output" / "model_runs.jsonl"
_WRITE_LOCK = Lock()


def _apply_retention():
    if not LOG_FILE.exists():
        return
    retention_days = int(os.getenv("MODEL_RUN_LOG_RETENTION_DAYS", os.getenv("EXECUTION_LOG_RETENTION_DAYS", "30")))
    if retention_days < 1:
        raise ValueError("MODEL_RUN_LOG_RETENTION_DAYS must be positive")
    cutoff = datetime.now(timezone.utc).timestamp() - retention_days * 86400
    retained = []
    for line in LOG_FILE.read_text(encoding="utf-8").splitlines():
        try:
            timestamp = datetime.fromisoformat(json.loads(line)["timestamp"]).timestamp()
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
        if timestamp >= cutoff:
            retained.append(line)
    LOG_FILE.write_text("".join(f"{line}\n" for line in retained), encoding="utf-8")


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
        _apply_retention()
        with LOG_FILE.open("a", encoding="utf-8") as log_file:
            log_file.write(f"{line}\n")

