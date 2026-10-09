import json
import re
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse, urldefrag
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

OUTPUT_FILE=Path("output/simulatedWorld.json")
MAX_DEPTH=2
MAX_PAGES_PER_SOURCE=25
REQUEST_TIMEOUT=20
REQUEST_DELAY_SECONDS=0.5
MIN_RELEVANCE_SCORE=5

GOVERNMENT_SOURCES = [
    # {
    #     "name": "Ministry of Power",
    #     "url": "https://powermin.gov.in/",
    # },
    # {
    #     "name": "CERC",
    #     "url": "https://cercind.gov.in/index-en.html",
    # },
    {
        "name": "website",
        "url": "http://localhost:8000"
    }
]

RELEVANCE_KEYWORDS = {

    # --------------------------------------------------------
    # SOLAR
    # --------------------------------------------------------

    "solar": 4,
    "solar power": 5,
    "solar generation": 5,
    "solar energy": 4,
    "photovoltaic": 4,
    "pv plant": 4,
    "solar plant": 4,
    "solar project": 4,
    "solar capacity": 4,
    "solar curtailment": 6,

    # --------------------------------------------------------
    # WIND
    # --------------------------------------------------------

    "wind": 4,
    "wind power": 5,
    "wind generation": 5,
    "wind energy": 4,
    "wind farm": 4,
    "wind project": 4,
    "wind capacity": 4,
    "wind curtailment": 6,

    # --------------------------------------------------------
    # ELECTRICITY PRICE / MARKET
    # --------------------------------------------------------

    "electricity price": 6,
    "power price": 6,
    "electricity market": 5,
    "power market": 5,
    "market price": 5,
    "tariff": 4,
    "tariff order": 5,
    "day ahead market": 6,
    "day-ahead market": 6,
    "real time market": 6,
    "real-time market": 6,
    "rtm": 4,
    "power exchange": 4,
    "electricity trading": 5,
    "energy trading": 5,

    # --------------------------------------------------------
    # GRID
    # --------------------------------------------------------

    "grid": 2,
    "grid stability": 6,
    "grid security": 6,
    "grid congestion": 7,
    "transmission congestion": 7,
    "transmission constraint": 7,
    "transmission constraints": 7,
    "transmission": 3,
    "transmission system": 4,
    "power transmission": 4,
    "grid frequency": 6,
    "frequency regulation": 6,
    "frequency response": 6,
    "grid code": 6,
    "load dispatch": 5,
    "load despatch": 5,
    "load dispatch centre": 5,
    "load despatch centre": 5,
    "power supply": 4,
    "power shortage": 6,
    "power surplus": 5,
    "renewable integration": 6,
    "renewable energy integration": 6,
    "curtailment": 6,
    "ancillary services": 6,
    "automatic generation control": 5,
    "agc": 3,
    "scuc": 4,
    "sced": 4,

    # --------------------------------------------------------
    # ELECTRICITY DEMAND / CONSUMPTION
    # --------------------------------------------------------

    "electricity demand": 6,
    "power demand": 5,
    "peak demand": 6,
    "demand forecast": 6,
    "load forecast": 5,
    "electricity consumption": 5,
    "power consumption": 5,
    "energy consumption": 4,
    "industrial demand": 6,
    "industrial consumption": 6,
    "industrial production": 4,
    "manufacturing": 3,
    "data centre": 5,
    "data center": 5,
    "electric vehicle": 4,
    "ev charging": 5,

    # --------------------------------------------------------
    # BATTERY / ENERGY STORAGE
    # --------------------------------------------------------

    "battery": 4,
    "battery storage": 6,
    "energy storage": 6,
    "energy storage system": 6,
    "battery energy storage": 7,
    "battery energy storage system": 7,
    "bess": 7,
    "storage system": 4,
    "pumped storage": 6,
    "pumped hydro": 6,
    "storage capacity": 5,
    "storage project": 5,
    "ancillary service": 5,

    # --------------------------------------------------------
    # WEATHER / DEMAND DRIVERS
    # --------------------------------------------------------

    "heatwave": 5,
    "heat wave": 5,
    "temperature": 2,
    "extreme weather": 5,
    "weather event": 4,
    "cyclone": 5,
    "storm": 5,
    "flood": 4,
    "drought": 4,

    # --------------------------------------------------------
    # RENEWABLE ENERGY
    # --------------------------------------------------------

    "renewable energy": 4,
    "renewable generation": 5,
    "renewable power": 4,
    "renewable source": 3,
    "renewable sources": 3,
    "green energy": 3,
    "green energy open access": 6,
}


# Link text / URL keywords that indicate that a link is
# probably worth following.

LINK_KEYWORDS = [
    "solar",
    "wind",
    "renewable",
    "electricity",
    "power",
    "energy",
    "grid",
    "transmission",
    "tariff",
    "market",
    "demand",
    "generation",
    "battery",
    "storage",
    "bess",
    "notification",
    "regulation",
    "regulations",
    "order",
    "circular",
    "report",
    "forecast",
    "consultation",
    "draft",
]


# File types that we don't want to crawl.

IGNORED_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".webp",
    ".ico",
    ".css",
    ".js",
    ".zip",
    ".rar",
    ".7z",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".exe",
    ".dmg",
}

class Webscrapping:
    def __init__(self):
        self.session = requests.Session()

        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 "
                "(Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 "
                "(KHTML, like Gecko) "
                "Chrome/120.0 Safari/537.36 "
                "EnergyMarketResearchBot/1.0"
            ),
            "Accept": (
                "text/html,application/xhtml+xml,"
                "application/xml;q=0.9,"
                "application/pdf;q=0.8,*/*;q=0.7"
            ),
        })

        chrome_options = Options()

        chrome_options.add_argument("--headless")
        chrome_options.add_argument("--no-sandbox")
        chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument("--window-size=1920,1080")

        self.driver = webdriver.Chrome(options=chrome_options)

    def fetch_rendered_page(self, url):
        try:
            self.driver.get(url)

            time.sleep(1)

            return self.driver.page_source

        except Exception as e:
            print(f"Browser fetch failed for {url}: {e}")
            return None

    def extract_market_data(self, soup):

        text = soup.get_text(" ", strip=True)

        market_data = {}

        patterns = {

            "electricityPrice":
                r"Current Electricity Price\s*₹?\s*([0-9.]+)",

            "priceChange":
                r"Price Change\s*([-+]?[0-9.]+)%",

            "demand":
                r"System Demand\s*([0-9.]+)\s*GW",

            "demandForecast":
                r"Demand Forecast\s*([0-9.]+)\s*GW",

            "solarGeneration":
                r"Solar Generation\s*([0-9.]+)\s*GW",

            "windGeneration":
                r"Wind Generation\s*([0-9.]+)\s*GW",

            "batteryStateOfCharge":
                r"Battery State of Charge\s*([0-9.]+)%",

            "gridFrequency":
                r"Grid Frequency\s*([0-9.]+)\s*Hz",

            "transmissionConstraint":
                r"Transmission Constraint\s*(Yes|No)"
        }

        for field, pattern in patterns.items():

            match = re.search(
                pattern,
                text,
                re.IGNORECASE
            )

            if match:

                value = match.group(1)

                if field == "transmissionConstraint":

                    market_data[field] = (
                        value.lower() == "yes"
                    )

                else:

                    market_data[field] = float(value)

        return market_data

    def normalize_url(self, url):

        if not url:
            return None

        # Remove fragments:
        # https://example.com/page#section
        # becomes
        # https://example.com/page
        url, _ = urldefrag(url)

        parsed = urlparse(url)

        if parsed.scheme not in ("http", "https"):
            return None

        # Remove trailing slash except root
        if parsed.path != "/":
            url = url.rstrip("/")

        return url


    def is_same_domain(self, url, domain):

        parsed = urlparse(url)

        return parsed.netloc.lower() == domain.lower()


    def has_ignored_extension(self, url):

        path = urlparse(url).path.lower()

        return any(
            path.endswith(extension)
            for extension in IGNORED_EXTENSIONS
        )


    def is_pdf(self, url):

        return urlparse(url).path.lower().endswith(".pdf")
    
    def fetch(self, url):

        try:

            response = self.session.get(
                url,
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True
            )

            response.raise_for_status()

            return response

        except requests.RequestException as error:

            print(
                f"    [ERROR] Could not fetch "
                f"{url}: {error}"
            )

            return None
        
    def extract_html(self, html):

        soup = BeautifulSoup(html, "lxml")

        # Save title before removing elements.
        title = ""

        if soup.title:
            title = soup.title.get_text(
                " ",
                strip=True
            )

        # Remove elements that normally don't contain useful
        # article/report information.

        for element in soup([
            "script",
            "style",
            "noscript",
            "svg",
            "nav",
            "footer",
            "header",
            "form"
        ]):

            element.decompose()

        # Try to find a useful heading.

        heading = ""

        h1 = soup.find("h1")

        if h1:
            heading = h1.get_text(
                " ",
                strip=True
            )

        if not heading:

            h2 = soup.find("h2")

            if h2:
                heading = h2.get_text(
                    " ",
                    strip=True
                )

        # Extract body text.

        body_text = soup.get_text(
            separator=" ",
            strip=True
        )

        body_text = self.clean_text(body_text)

        return {
            "title": title,
            "heading": heading,
            "text": body_text,
            "soup": soup,
        }

    def clean_text(self, text):

        if not text:
            return ""

        # Replace multiple spaces/newlines.
        text = re.sub(
            r"\s+",
            " ",
            text
        )

        # Remove excessive repeated punctuation.
        text = re.sub(
            r"\.{3,}",
            "...",
            text
        )

        return text.strip()

    def extract_pdf(self, response):

        try:

            from pypdf import PdfReader

        except ImportError:

            print(
                "    [WARNING] pypdf is not installed. "
                "Skipping PDF."
            )

            return {
                "title": "",
                "heading": "",
                "text": "",
            }

        try:

            from io import BytesIO

            pdf_file = BytesIO(response.content)

            reader = PdfReader(pdf_file)

            pages = []

            for page in reader.pages:

                try:

                    page_text = page.extract_text()

                    if page_text:
                        pages.append(page_text)

                except Exception:
                    continue

            text = "\n".join(pages)

            text = self.clean_text(text)

            return {
                "title": "",
                "heading": "",
                "text": text,
            }

        except Exception as error:

            print(
                f"    [ERROR] Could not parse PDF: "
                f"{error}"
            )

            return {
                "title": "",
                "heading": "",
                "text": "",
            }
        
    def calculate_relevance(self, text):

        if not text:

            return 0, []

        text_lower = text.lower()

        score = 0

        matched_keywords = []

        for keyword, points in RELEVANCE_KEYWORDS.items():

            if keyword.lower() in text_lower:

                score += points

                matched_keywords.append(keyword)

        return score, matched_keywords


    # ========================================================
    # LINK RELEVANCE
    # ========================================================

    def is_relevant_link(self, url, link_text=""):

        combined = (
            f"{url} {link_text}"
        ).lower()

        for keyword in LINK_KEYWORDS:

            if keyword in combined:
                return True

        return False


    # ========================================================
    # LINK EXTRACTION
    # ========================================================

    def extract_links(
        self,
        soup,
        current_url,
        domain
    ):

        links = []

        for anchor in soup.find_all(
            "a",
            href=True
        ):

            href = anchor.get("href")

            if not href:
                continue

            absolute_url = urljoin(
                current_url,
                href
            )

            absolute_url = self.normalize_url(
                absolute_url
            )

            if not absolute_url:
                continue

            if not self.is_same_domain(
                absolute_url,
                domain
            ):
                continue

            if self.has_ignored_extension(
                absolute_url
            ):
                continue

            link_text = anchor.get_text(
                " ",
                strip=True
            )

            if self.is_relevant_link(
                absolute_url,
                link_text
            ):

                links.append(
                    absolute_url
                )

        return links


    # ========================================================
    # PAGE PROCESSING
    # ========================================================

    def process_page(self, url, source_name):

        # Use Selenium because the website loads its data dynamically with JavaScript.
        html = self.fetch_rendered_page(url)

        if not html:
            return None, []

        # Parse the rendered HTML.
        soup = BeautifulSoup(html, "html.parser")

        # Extract visible text from the rendered page.
        text = self.clean_text(
            soup.get_text(" ", strip=True)
        )

        # Calculate relevance.
        relevance_score, matched_keywords = self.calculate_relevance(text)

        # Get the domain so extract_links() can stay restricted
        # to the simulated website.
        domain = urlparse(url).netloc

        # Extract links from the rendered page.
        links = self.extract_links(
            soup,
            url,
            domain
        )

        # Ignore pages that are not relevant.
        if relevance_score < MIN_RELEVANCE_SCORE:
            return None, links

        # Extract raw market facts.
        market_data = self.extract_market_data(soup)

        result = {
            "source": source_name,
            "title": (
                soup.title.get_text(strip=True)
                if soup.title
                else ""
            ),
            "heading": (
                soup.find("h1").get_text(" ", strip=True)
                if soup.find("h1")
                else ""
            ),
            "url": url,
            "content_type": "html",
            "relevance_score": relevance_score,
            "matched_keywords": matched_keywords,
            "text": text,
            "market_data": market_data
        }

        return result, links


    # ========================================================
    # RECURSIVE CRAWLER
    # ========================================================

    def crawl(
        self,
        source_name,
        start_url,
        max_depth=MAX_DEPTH,
        max_pages=MAX_PAGES_PER_SOURCE
    ):

        start_url = self.normalize_url(
            start_url
        )

        if not start_url:
            return []


        domain = urlparse(
            start_url
        ).netloc


        # Queue contains:
        #
        # (url, depth)

        queue = deque()

        queue.append(
            (
                start_url,
                0
            )
        )


        visited = set()

        results = []


        print()
        print("=" * 70)
        print(f"Starting source: {source_name}")
        print(f"URL: {start_url}")
        print("=" * 70)


        while queue and len(visited) < max_pages:

            current_url, depth = (
                queue.popleft()
            )


            if current_url in visited:
                continue


            if depth > max_depth:
                continue


            visited.add(
                current_url
            )


            print()
            print(
                f"[{len(visited)}/{max_pages}] "
                f"Depth {depth}"
            )


            result, links = (
                self.process_page(
                    current_url,
                    source_name
                )
            )


            if result:

                print(
                    "    [RELEVANT]"
                    f" score={result['relevance_score']}"
                )

                print(
                    "    Keywords:",
                    ", ".join(
                        result[
                            "matched_keywords"
                        ][:10]
                    )
                )

                results.append(
                    result
                )

            else:

                print(
                    "    [NOT RELEVANT]"
                )


            # Don't go deeper from this page if
            # we've reached the configured depth.

            if depth >= max_depth:
                continue


            # Add new links to the queue.

            for link in links:

                if link in visited:
                    continue

                if link in (
                    item[0]
                    for item in queue
                ):
                    continue

                queue.append(
                    (
                        link,
                        depth + 1
                    )
                )


            # Be polite to the government server.

            time.sleep(
                REQUEST_DELAY_SECONDS
            )


        print()
        print(
            f"Finished {source_name}: "
            f"{len(visited)} pages visited, "
            f"{len(results)} relevant pages found."
        )


        return results


# ============================================================
# RESULT CLEANUP
# ============================================================

def deduplicate_results(results):

    seen_urls = set()

    unique_results = []

    for result in results:

        url = result.get("url")

        if not url:
            continue

        if url in seen_urls:
            continue

        seen_urls.add(url)

        unique_results.append(result)

    return unique_results


def sort_results(results):

    return sorted(
        results,
        key=lambda item: (
            item.get(
                "relevance_score",
                0
            ),
            len(
                item.get(
                    "text",
                    ""
                )
            )
        ),
        reverse=True
    )


# ============================================================
# SAVE JSON
# ============================================================

def save_results(results):

    OUTPUT_FILE.parent.mkdir(
        parents=True,
        exist_ok=True
    )


    output = {

        "generated_at": datetime.now(
            timezone.utc
        ).isoformat(),

        "total_results": len(results),

        "results": results,
    }


    with open(
        OUTPUT_FILE,
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            output,
            file,
            indent=2,
            ensure_ascii=False
        )


    print()
    print("=" * 70)
    print(
        f"Saved {len(results)} results to:"
    )
    print(
        OUTPUT_FILE
    )
    print("=" * 70)


# ============================================================
# MAIN
# ============================================================

def main():

    scraper = Webscrapping()

    all_results = []


    for source in GOVERNMENT_SOURCES:

        results = scraper.crawl(
            source_name=source["name"],
            start_url=source["url"],
            max_depth=MAX_DEPTH,
            max_pages=MAX_PAGES_PER_SOURCE
        )

        all_results.extend(
            results
        )


    # Remove duplicate URLs.

    all_results = (
        deduplicate_results(
            all_results
        )
    )


    # Highest relevance first.

    all_results = (
        sort_results(
            all_results
        )
    )


    save_results(
        all_results
    )


if __name__ == "__main__":

    main()