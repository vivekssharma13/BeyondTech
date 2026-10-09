import feedparser

class NewsService:
    def __init__(self):
        self.feedURLS = [
            "https://renewablesnow.com/feeds/solar/",
            "https://renewablesnow.com/feeds/wind/",
            "https://renewablesnow.com/feeds/energy-storage/"
        ]

    def getRelevantNews(self):
        articles=[]
        for feedURL in self.feedURLS:
            feed = feedparser.parse(feedURL)
            for entry in feed.entries[:5]:
                articles.append({
                    "title": entry.get("title", ""),
                    "description": entry.get("summary", ""),
                    "source": feedURL,
                    "published": entry.get("published", ""),
                    "url": entry.get("link", "")
                })
            return articles
    # def get_relevant_news(self):

    #     return [
    #         {
    #             "title": "High industrial activity expected in region",
    #             "description": "Industrial demand is expected to increase.",
    #             "source": "Demo Source"
    #         }
    #     ]