# Market data contract and local import policy

Phase 2B.1 provides persistence and ingestion only. It does not activate demo
prices, train a model, or alter the existing Market Agent.

`reference_market_definition.js` defines the inactive fictional shared-reference
market contract. Its source mode is `UNAVAILABLE`; it contains no price values,
trading schedule, price cap, or clearing-rule assumption.

## Historical CSV format

Imports are operator-controlled and require an accompanying manifest based on
`import_manifest.example.json`. The operator is responsible for documenting and
having permission to use the supplied dataset. The importer does not download or
scrape data. `expectedDeliveryStart` and `expectedDeliveryEnd` are mandatory,
end-exclusive boundaries used to detect leading, internal, and trailing missing
blocks.

Required CSV columns:

```csv
delivery_start,delivery_end,price
2026-01-01T00:00:00+05:30,2026-01-01T00:15:00+05:30,5200.25
```

Optional columns are `currency`, `price_unit`, `publication_timestamp`, and
`revision_identifier`. Timestamps must be ISO-8601 with `Z` or an explicit UTC
offset. The manifest preserves the source timezone; SQLite stores canonical UTC.

Canonical price storage is signed integer paise per MWh. `INR_PER_KWH` input is
multiplied by 1,000 explicitly before canonical storage. Values that cannot be
represented exactly to one paise per MWh are rejected rather than rounded.

Run an import from `backend/`:

```bash
npm run market:import -- --file /approved/path/prices.csv --manifest /approved/path/manifest.json
```

Validated raw CSV and normalized manifest copies are retained by SHA-256 under
`backend/data/market_imports/`. That directory is local and git-ignored because
the repository does not assume redistribution rights. Re-importing the same
dataset ID, source bytes, and manifest is idempotent. Changed content under an
existing dataset ID is rejected. A different revision identifier preserves a
new interval revision rather than overwriting the old one.

Missing 15-minute blocks produce `INCOMPLETE` data-quality status and are never
invented. Invalid timestamps, duplicate interval/revision identities, unit or
currency mismatches, and inexact financial conversions fail the import.
