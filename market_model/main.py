from app.agent import MarketAgent


def main():

    agent = MarketAgent()

    result = agent.run()

    print("\n===== MARKET AGENT RESULT =====\n")
    print(result)


if __name__ == "__main__":
    main()