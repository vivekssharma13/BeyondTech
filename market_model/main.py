import json
import sys

def main():
    from agent import MarketAgent

    agent = MarketAgent()

    raw = sys.stdin.read().strip()
    supplied_evidence = json.loads(raw) if raw else None
    result = agent.run(supplied_evidence)

    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Market Agent failed: {error}", file=sys.stderr)
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
        raise SystemExit(1)
