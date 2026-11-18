#!/usr/bin/env python3
"""Find grant programmes that are not in the dataset yet, and add the good ones.

Two kinds of search seed:

  * every page already monitored in js/data.js — any grant-shaped link on its own
    domain that is not already a source becomes a candidate;
  * a short list of public funding directories that a plain HTTP GET returns as
    real HTML (Funding Scotland, Funding Wales, GOV.UK Find a grant, plus a couple
    of community foundation programme indexes).

A candidate is only accepted when the page behind it genuinely looks like a grant
programme for organisations: it must fetch, carry readable text, name an amount, a
deadline or a rolling/open statement, and say who can apply. Accepted candidates
are appended to js/data.js as `confidence: 'check'` entries with `origin: 'auto'`,
so the app can label them and hide them. Everything else is queued for a human in
data-check/discovery.json — nothing is ever edited, only appended.

    python3 tools/discover.py            # search and append what passes
    python3 tools/discover.py --dry-run  # search, report, change nothing
    python3 tools/discover.py --max-new 4 --jobs 8

Exit code is 1 if a seed page could not be fetched, 0 otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))

from check_sources import (  # noqa: E402  (shared helpers, same folder)
    MAX_BYTES,
    OUT_DIR,
    ROOT,
    USER_AGENT,
    PageText,
    clean_title,
    load_funds,
)

DATA_FILE = ROOT / "js" / "data.js"
DISCOVERY_FILE = OUT_DIR / "discovery.json"
NEW_FUNDS_FILE = OUT_DIR / "new-funds.js"
BACKUP_DIR = OUT_DIR / "backups"
LEDGER_DAYS = 120
RETRY_DAYS = {"rejected": 60, "queued": 7}
MAX_NEW_PER_RUN = 8
MAX_CANDIDATES = 60
MIN_TEXT = 600
BACKUPS_KEPT = 5

# Public listing pages whose own links point at grant programmes. Each is fetched
# with one plain GET; a seed that fails to load simply contributes nothing.
DIRECTORY_SEEDS = [
    "https://funding.scot/",
    "https://funding.cymru/en/",
    "https://find-government-grants.service.gov.uk/grants",
    "https://quartetcf.org.uk/apply-for-funding/apply-for-a-grant/",
    "https://mkcommunityfoundation.co.uk/apply-for-a-grant/",
    # Nottingham CVS posts a dated write-up of each live fund (deadline, who can
    # apply, how much) under /news-and-events/, so the funding-only topic listing
    # below works like a directory of programmes.
    "https://www.nottinghamcvs.co.uk/news-and-events/news-articles?tid%5B12%5D=12&page=0",
]

# Listings that publish each programme as a news article: (host, article path prefix).
# There the article heading and slug name the fund, so links are accepted even
# though their URLs live under /news/ and carry no grant word.
NEWS_LISTINGS = [("nottinghamcvs.co.uk", "/news-and-events/")]

# Hosts that never host a funder's own programme page.
HOST_SKIP = {
    "facebook.com", "twitter.com", "x.com", "instagram.com", "linkedin.com",
    "youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "pinterest.com",
    "threads.net", "bsky.app", "whatsapp.com", "google.com", "apple.com",
    "eventbrite.co.uk", "eventbrite.com", "justgiving.com", "crowdfunder.co.uk",
    "gofundme.com", "medium.com", "wordpress.com", "blogspot.com", "wixsite.com",
    "mailchimp.com", "zoom.us", "paypal.com", "stripe.com", "amazon.co.uk",
    "ebay.co.uk", "the-list.uk", "grantnav.threesixtygiving.org",
    "www.dsc.org.uk", "grantfinder.co.uk", "ncvo.org.uk", "turn2us.org.uk",
    "goodfinance.org.uk", "mycommunity.org.uk", "typeform.com", "unltduk.typeform.com",
    "lotterygoodcauses.org.uk", "fundingcentral.org.uk", "charityexcellence.co.uk",
    "grantsonline.org.uk", "fundsforngos.org", "wikipedia.org", "youtube-nocookie.com",
}

# Whole path segments that name a grants index, a guidance page or a section
# rather than one programme.
GENERIC_SEGMENT = re.compile(
    r"^(funding|funds|fund|grants?|our-grants|all-grants|current-grants|open-grants|"
    r"grants-overview|grants-support|grants-at-a-glance|grant-programmes|funding-programmes|"
    r"funding-opportunities|how-we-fund|what-we-fund|what-we-dont-fund|who-we-fund|"
    r"apply|apply-for-funding|apply-for-a-grant|available-grants|finding-funding|"
    r"funding-and-campaigns|funding-support|business-finance-support|support$|"
    r"application-questions|applications?-0|knowledge|knowledge-hub|hub|priorities|"
    r"our-priorities|grantees|grant-holders|current-grant-holders|directory)$",
    re.I,
)
LOCALE_SEGMENTS = {"en", "cy", "en-gb", "cy-gb", "gd", "ga", "ie", "uk"}
LABEL_STOPWORDS = {
    "apply", "applying", "application", "applications", "fund", "funds", "funding",
    "grant", "grants", "grantee", "grantees", "our", "your", "the", "a", "an", "for",
    "to", "of", "and", "or", "in", "on", "with", "all", "view", "see", "more",
    "learn", "read", "find", "out", "about", "what", "we", "how", "who", "at", "glance",
    "info", "information", "click", "here", "now", "us", "is", "are", "can", "this",
    "that", "page", "site", "website", "cymraeg", "english", "home", "homepage",
    "go", "back", "next", "previous", "details", "detail", "overview", "explore",
}
GENERIC_SUFFIX = re.compile(
    r"(?:^|-)(directory|hub|finder|checker|index|guidance|guidelines|questions|"
    r"eligibility|criteria|priorities|resources|toolkit|sitemap)$",
    re.I,
)
NAME_BAD = re.compile(
    r"(guidance|guidelines|application questions|what we (?:don'?t|do not) fund|exclusions|"
    r"eligibility|how to apply|checklist|faqs?|terms|policy|priorities|glossary|index|"
    r"case stud|success stor|funded project|grant holders|grantees|what is|overview$|"
    r"is part of|are part of|in partnership with)",
    re.I,
)
BOILERPLATE_HEADING = re.compile(
    r"^(let us know|we use cookies|cookies?\b|agree\b|accept\b|subscribe|newsletter|skip to|"
    r"menu|search|navigation|javascript|enable javascript|loading|please wait|sign in|"
    r"log in|your basket|shopping|cookie)",
    re.I,
)

GRANT_WORDS = re.compile(
    r"\b(grant|grants|fund|funding|programme|program|scheme|award|awards|bursary|"
    r"investment|endowment|microgrant)\b",
    re.I,
)
BAD_PATH = re.compile(
    r"(about|contact|news|blog|press|privacy|cookie|terms|licen|login|log-in|sign-?in|"
    r"sign-?up|register|my-account|account|search|tag/|category|author|team|staff|"
    r"job|vacanc|career|event|webinar|report|publication|policy|governance|annual|"
    r"strateg|impact-report|donate|fundraising-ideas|volunteer|membership|shop|basket|"
    r"checkout|newsletter|subscribe|accessibility|sitemap|faq|stories|story|case-stud|"
    r"testimonial|download|portal|adviser|advisors|glossary|quiz|survey|enquir|complaint|"
    r"complaints|safeguarding|conference|training-course|podcast|press-release|"
    r"eligib|criteria|guidance|guidelin|process$|checklist|top-tips|how-to-apply|"
    r"apply/?$|forms?/?$|rules|advice|helpline|contact-us|what-we-fund/?$|"
    r"who-can-apply|resources?|toolkit|template|example|impact/?$|our-grants/?$)",
    re.I,
)
BAD_EXT = re.compile(r"\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|svg|mp4|mp3|ics|csv)$", re.I)
BAD_QUERY = re.compile(r"(^|&)(page|p|s|q|search|sort|order|filter|offset|start)=", re.I)
ORG_CUE = re.compile(
    r"\b(charit(?:y|ies|able)|organis|organization|community group|not[- ]for[- ]profit|"
    r"non[- ]profit|social enterprise|CIC|CICs|constituted|voluntary sector|third sector|"
    r"trustees?|community interest compan)\b",
    re.I,
)
DEADLINE_CUE = re.compile(
    r"(clos(?:e|es|ed|ing)|deadline|apply by|applications? (?:must|need|close|by)|"
    r"no later than|submit by|last date|due by|end of the round)",
    re.I,
)
APPLY_CUE = re.compile(
    r"(apply (?:now|online|here|by|for|to|via)|applications? (?:are )?(?:open|welcome|accepted|invited)|"
    r"open for applications|we (?:are )?(?:accepting|invite|welcome)|application form|"
    r"how to apply|make an application|to apply\b)",
    re.I,
)
ROLLING_CUE = re.compile(
    r"(rolling|ongoing|on a rolling basis|continuous|no (?:stated |set |fixed |specific )?deadline|no closing date|open all year|"
    r"all year round|any time|at any point)",
    re.I,
)
CLOSED_CUE = re.compile(
    r"\b(now closed|is closed|currently closed|not currently open|paused|suspended|"
    r"no longer accepting|no longer open|closed to applications)\b",
    re.I,
)
TOTAL_CUE = re.compile(
    r"(total|overall|budget|we have awarded|has awarded|awarded to date|since \d{4}|programme pot|"
    r"available in this round|to be distributed|per year across)",
    re.I,
)
AWARD_CUE = re.compile(
    r"(up to|between|award(?:s|ed)? (?:of|from|between)|grant(?:s)? of|maximum|max\.|minimum|min\.|"
    r"typically|usually|on average|per year|per annum|each year|per grant|per project|per organisation|"
    r"worth|size of)",
    re.I,
)
ORG_ONLY_CUE = re.compile(
    r"(we (?:only )?fund (?:organisations|charities|groups)|for organisations? only|"
    r"applications? (?:are )?(?:welcome|open|invited) from (?:charities|organisations|community|"
    r"groups|not-for-profits|CICs)|must be a (?:registered )?(?:charity|CIC|community group|"
    r"not-for-profit|constituted|company)|your organisation must be|"
    r"constituted (?:group|organisation|community)|not-for-profit organisations?|"
    r"charities, community groups|community groups and charities)",
    re.I,
)
ELIG_CUE = re.compile(
    r"(who can apply|eligib|apply if|you can apply|applications? (?:are )?(?:welcome|open)|"
    r"we (?:fund|support|welcome)|open to|criteria|must be)",
    re.I,
)
INDIVIDUAL_CUE = re.compile(
    r"(individuals? (?:only|and families)|personal grants|grants to individuals|"
    r"applications? from individuals|for individuals|students?\b|scholarships?|"
    r"undergraduates?|pupils?|families in need)",
    re.I,
)
NAV_LINE = re.compile(
    r"(^home\b|skip to|> \w|» |menu|read more →|back to top|cookie|newsletter sign|follow us|"
    r"share (?:this|on)|^\W*$)",
    re.I,
)

MONEY_RE = re.compile(r"£\s?(\d[\d,]*(?:\.\d+)?)\s?(k|thousand|million|m)?", re.I)
MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
    "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
DATE_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
    r"aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(20\d{2})\b"
    r"|\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b"
    r"|\b(20\d{2})-(\d{2})-(\d{2})\b",
    re.I,
)
OPEN_CUE = re.compile(
    r"(open(?:s|ing)?(?: on| for)?|applications? open|round \d+ open|from|starting|begins)",
    re.I,
)
WEEKS_RE = re.compile(
    r"(\d{1,2})\s*(?:to|-|–)?\s*(\d{1,2})?\s*(weeks?|months?)",
    re.I,
)
DECISION_CUE = re.compile(r"(decision|outcome|hear|notified|notification|let you know|respond)", re.I)
FUNDER_SENTENCE = re.compile(
    r"(?:^|[.;]\s|\n)\s*(?:The\s+)?"
    r"((?:[A-Z][\w&'’.\-]*|\b(?:of|the|and|for|&)\b)"
    r"(?:[ \t]+(?:[A-Z][\w&'’.\-]*|\b(?:of|the|and|for|&)\b)){0,5})\s+"
    r"(?:supports|provides|offers|funds|awards|gives|has funding of|makes grants)",
)
CHARITY_NO_RE = re.compile(r"(?:registered )?charity (?:number|no\.?|reg(?:istration)?\.?)\s*:?\s*(\d{6,8})", re.I)

CATEGORY_WORDS = [
    ("Poverty & disadvantage", r"(poverty|disadvantag|hardship|cost of living|low income|financial exclusion|food poverty)"),
    ("Children & young people", r"(children|young people|youth|young person|teenagers)"),
    ("Health & wellbeing", r"(health|wellbeing|well-being|mental health|isolat|loneliness|care|hospice|disabilit)"),
    ("Skills & employment", r"(skills|employ|training|apprentice|education|literacy|numeracy|workforce|enterprise support)"),
    ("Environment", r"(environment|climate|nature|wildlife|biodiversity|green space|sustainab|conservation)"),
    ("Arts & culture", r"(arts|music|theatre|dance|culture|creativ|literature|film)"),
    ("Heritage", r"(heritage|historic|museum|archive|listed building)"),
    ("Sport", r"(sport|physical activity|swimming|football|cycling|leisure)"),
    ("Social enterprise", r"(social enterprise|social investment|trading income|community business)"),
    ("Community", r"(community|neighbourhood|residents|local people|volunteering)"),
]


# --------------------------------------------------------------------------- #
# URLs and dataset index
# --------------------------------------------------------------------------- #

def registrable(host: str) -> str:
    host = (host or "").lower().split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    if len(parts) <= 2:
        return host
    multi = {"co", "org", "ac", "gov", "sch", "nhs", "ltd", "plc", "me", "net", "com"}
    if parts[-2] in multi and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def norm_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = strip_locale(parts.path.rstrip("/") or "/")
    return urlunsplit((parts.scheme or "https", host, path, "", ""))


def strip_locale(path: str) -> str:
    """Drop a leading language segment: /cy-gb/funding/youth-fund -> /funding/youth-fund."""
    parts = [part for part in path.split("/") if part]
    while len(parts) > 1 and parts[0].lower() in LOCALE_SEGMENTS:
        parts.pop(0)
    return "/" + "/".join(parts) if parts else "/"


def text_path(path: str) -> str:
    return strip_locale(path.rstrip("/") or "/").lower()


def slugify(value: str, limit: int = 48) -> str:
    text = unicodedata.normalize("NFKD", value or "").encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:limit].strip("-") or "fund"


def dataset_index(funds: list[dict]) -> dict:
    index = {"urls": set(), "hosts": {}, "ids": set(), "names": []}
    for fund in funds:
        for key in ("sourceUrl", "applyUrl"):
            if fund.get(key):
                index["urls"].add(norm_url(fund[key]))
        host = registrable(urlsplit(fund.get("sourceUrl", "")).netloc)
        if host:
            index["hosts"].setdefault(host, []).append(fund)
        index["ids"].add(fund["id"])
        index["names"].append((host, slugify(fund.get("name", "")), fund.get("name", "")))
    return index


def similar_to_known(index: dict, host: str, name: str) -> str:
    """Return the name of an existing fund this candidate looks like, if any."""
    slug = slugify(name)
    if len(slug) < 5:
        return ""
    for known_host, known_slug, known_name in index["names"]:
        if known_host and host and known_host != host:
            # An aggregator lists a funder's programme under the funder's own name,
            # so a long shared opening is the same programme on another site.
            if len(slug) >= 15 and (known_slug.startswith(slug) or slug.startswith(known_slug)):
                return known_name
            continue
        if not known_slug or not slug:
            continue
        if slug == known_slug or slug.startswith(known_slug) or known_slug.startswith(slug):
            return known_name
    return ""


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #

def fetch(url: str, timeout: float) -> dict:
    page = {
        "url": url, "final_url": url, "status": None, "ok": False, "error": "",
        "title": "", "text": "", "h1": "", "description": "", "site_name": "",
        "links": [], "content_type": "",
    }
    request = Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    })
    try:
        with urlopen(request, timeout=timeout) as response:
            page["status"] = response.status
            page["final_url"] = response.geturl()
            page["content_type"] = response.headers.get_content_type()
            charset = response.headers.get_content_charset() or "utf-8"
            raw = response.read(MAX_BYTES)
    except HTTPError as exc:
        page["status"] = exc.code
        page["error"] = f"HTTP {exc.code} {exc.reason}"
        return page
    except (URLError, TimeoutError, OSError) as exc:
        page["error"] = f"connection failed: {getattr(exc, 'reason', exc)}"
        return page
    except Exception as exc:  # a bad page must not end the run
        page["error"] = f"{type(exc).__name__}: {exc}"
        return page

    if "html" not in page["content_type"] and "xml" not in page["content_type"]:
        page["error"] = f"not HTML ({page['content_type']})"
        return page
    try:
        document = raw.decode(charset, errors="replace")
    except LookupError:
        document = raw.decode("utf-8", errors="replace")
    parser = PageText()
    try:
        parser.feed(document)
        parser.close()
    except Exception:
        pass
    page["ok"] = True
    page["title"] = clean_title(parser.title)
    page["h1"] = clean_title(re.sub(r"\s+", " ", parser.h1))
    page["description"] = parser.description
    page["site_name"] = parser.site_name
    page["text"] = unicodedata.normalize("NFKC", parser.text())
    page["links"] = parser.links
    return page


# --------------------------------------------------------------------------- #
# Link selection
# --------------------------------------------------------------------------- #

def label_is_name(label: str) -> bool:
    """True when the link text reads like a fund name rather than “Read more”."""
    words = re.findall(r"[a-z]{3,}", (label or "").lower())
    distinctive = [word for word in words if word not in LABEL_STOPWORDS]
    return len("".join(distinctive)) >= 4


def slug_is_name(segment: str) -> bool:
    words = re.findall(r"[a-z]{3,}", (segment or "").lower())
    distinctive = [word for word in words if word not in LABEL_STOPWORDS]
    return len("".join(distinctive)) >= 5


def programme_link(raw_url: str, label: str, base: str) -> str:
    """Return a normalised programme URL, or '' when the link is not one."""
    if not raw_url or raw_url.startswith(("mailto:", "tel:", "javascript:", "#")):
        return ""
    try:
        absolute = urljoin(base, raw_url.strip())
    except ValueError:
        return ""
    parts = urlsplit(absolute)
    if parts.scheme not in ("http", "https"):
        return ""
    host = registrable(parts.netloc)
    if not host or host in HOST_SKIP or any(host.endswith("." + skip) for skip in HOST_SKIP):
        return ""
    seed_host = registrable(urlsplit(base).netloc)
    article = host == seed_host and any(
        host == site and parts.path.startswith(prefix) for site, prefix in NEWS_LISTINGS
    )
    if BAD_EXT.search(parts.path) or parts.path in ("", "/"):
        return ""
    if not article and (BAD_QUERY.search(parts.query) or BAD_PATH.search(parts.path)):
        return ""
    segments = [segment for segment in strip_locale(parts.path).split("/") if segment]
    if not segments or GENERIC_SEGMENT.match(segments[-1]) or GENERIC_SUFFIX.search(segments[-1]):
        return ""
    look = (parts.path + " " + parts.query).lower()
    if not article and not (GRANT_WORDS.search(look) or GRANT_WORDS.search(label or "")):
        return ""
    if len(label or "") > 90:
        return ""
    if not (label_is_name(label) or slug_is_name(segments[-1])):
        return ""
    return norm_url(absolute)


def seed_pages(funds: list[dict]) -> list[dict]:
    seeds = [{"url": url, "fund": None} for url in DIRECTORY_SEEDS]
    seen = {norm_url(seed["url"]) for seed in seeds}
    for fund in funds:
        url = fund.get("sourceUrl") or ""
        key = norm_url(url)
        if not url or key in seen:
            continue
        seen.add(key)
        seeds.append({"url": url, "fund": fund})
    return seeds


def still_decided(record: dict, today: date) -> bool:
    """True when a earlier candidate should be left alone on this run.

    Added funds are never re-added. A page that failed its checks is retried
    after a while, because grant rounds reopen.
    """
    status = record.get("status")
    if status == "added":
        return True
    if record.get("over_cap"):
        return False  # it passed the checks: reconsider it on the next run
    window = RETRY_DAYS.get(status or "")
    if not window:
        return False
    try:
        when = datetime.fromisoformat(
            record.get("last_checked") or record.get("first_seen") or ""
        ).date()
    except ValueError:
        return False
    return (today - when).days < window


def collect_candidates(seeds: list[dict], pages: dict[str, dict], index: dict,
                       ledger: dict, today: date) -> list[dict]:
    candidates: list[dict] = []
    by_url: dict[str, dict] = {}
    for seed in seeds:
        page = pages.get(seed["url"])
        if not page or not page["ok"]:
            continue
        seed_host = registrable(urlsplit(page["final_url"]).netloc)
        for href, label in page["links"]:
            url = programme_link(href, label, page["final_url"])
            if not url or url in by_url:
                continue
            host = registrable(urlsplit(url).netloc)
            same_site = bool(seed["fund"]) and host == seed_host
            if url in index["urls"]:
                continue
            if url in ledger and still_decided(ledger[url], today):
                continue
            candidate = {
                "url": url,
                "label": clean_title(label)[:120],
                "seed": seed["url"],
                "seed_host": seed_host,
                "seed_fund": (seed["fund"] or {}).get("id", ""),
                "funder": (seed["fund"] or {}).get("funder", "") if same_site else "",
                "scope_hint": (seed["fund"] or {}).get("scope", "") if same_site else "",
                "origin": "same site" if same_site else "directory",
            }
            by_url[url] = candidate
            candidates.append(candidate)
    return candidates


def spread_candidates(candidates: list[dict], limit: int) -> list[dict]:
    """Take candidates in turn from each seed so no single site fills the run."""
    if limit <= 0 or len(candidates) <= limit:
        return candidates
    grouped: dict[str, list[dict]] = {}
    for candidate in candidates:
        grouped.setdefault(candidate["seed"], []).append(candidate)
    queues = [list(grouped[key]) for key in grouped]
    chosen: list[dict] = []
    while len(chosen) < limit and queues:
        for queue in queues:
            if queue:
                chosen.append(queue.pop(0))
                if len(chosen) >= limit:
                    break
        queues = [queue for queue in queues if queue]
    return chosen


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #

def money_values(text: str) -> list[float]:
    values: list[float] = []
    for match in MONEY_RE.finditer(text):
        try:
            number = float(match.group(1).replace(",", ""))
        except ValueError:
            continue
        unit = (match.group(2) or "").lower()
        if unit in ("k", "thousand"):
            number *= 1000
        elif unit in ("m", "million"):
            number *= 1_000_000
        window = text[max(0, match.start() - 90): match.end() + 90]
        if TOTAL_CUE.search(window) and number >= 100_000:
            continue
        if not AWARD_CUE.search(window):
            continue
        if 100 <= number <= 5_000_000:
            values.append(number)
    values = sorted(set(values))
    # A programme total can still slip through beside a per-grant maximum.
    while len(values) > 1 and values[-1] >= 100_000 and values[-1] > values[0] * 10:
        values.pop()
    return values


def find_dates(text: str):
    """Yield (date, span start, span end) for every readable date in the text."""
    for match in DATE_RE.finditer(text):
        try:
            if match.group(1):  # 23 November 2026
                day = int(match.group(1))
                month = MONTHS[match.group(2)[:3].lower()]
                year = int(match.group(3))
            elif match.group(4):  # 23/11/2026 (day first, UK convention)
                day, month, year = int(match.group(4)), int(match.group(5)), int(match.group(6))
                if month > 12 and day <= 12:
                    day, month = month, day
            else:  # 2026-11-23
                year, month, day = int(match.group(7)), int(match.group(8)), int(match.group(9))
            yield date(year, month, day), match.start(), match.end()
        except (KeyError, ValueError):
            continue


def pick_deadline(text: str, today: date, cue: re.Pattern) -> date | None:
    """Earliest date that sits next to a deadline-ish phrase and is not long past."""
    found: list[date] = []
    for value, start, end in find_dates(text):
        if value < today - timedelta(days=90) or value > today + timedelta(days=900):
            continue
        window = text[max(0, start - 140): end + 140]
        if cue.search(window):
            found.append(value)
    if not found:
        return None
    future = [d for d in found if d >= today]
    return min(future) if future else max(found)


def sentences(text: str, cue: re.Pattern, limit: int = 3, width: int = 240,
              min_len: int = 30) -> list[str]:
    """Quotable lines that mention ``cue``, skipping navigation and button text."""
    out: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not (min_len <= len(line) <= 400) or not cue.search(line):
            continue
        if NAV_LINE.search(line):
            continue
        if line.isupper() or len(re.findall(r"[A-Za-z]", line)) < 12:
            continue
        value = line if len(line) <= width else line[: width - 1].rstrip() + "…"
        if value not in out:
            out.append(value)
        if len(out) >= limit:
            break
    return out


def org_status(text: str, words: str) -> str:
    for match in re.finditer(words, text, re.I):
        window = text[max(0, match.start() - 220): match.end() + 220]
        if ELIG_CUE.search(window) or APPLY_CUE.search(window):
            return "yes"
    return "check"


def title_head(title: str) -> str:
    """The fund-ish part of a page title: “Core costs | BBC Children in Need” -> Core costs."""
    if not title:
        return ""
    for separator in (" | ", " – ", " — ", " - ", " · ", " :: "):
        if separator in title:
            head = title.split(separator)[0].strip()
            if len(head) >= 5:
                return head
    return title.strip()


def clean_name(page: dict, candidate: dict) -> str:
    raw = ""
    if page["h1"] and not BOILERPLATE_HEADING.match(page["h1"]):
        raw = page["h1"]
    if not raw and label_is_name(candidate["label"]):
        raw = candidate["label"]
    if not raw:
        raw = title_head(page["title"])
    if len(raw) > 55 and raw[20:50] and raw[20:50] in raw[:20]:
        raw = raw[: raw.index(raw[20:50]) + 30]
    name = re.sub(r"\s+", " ", raw or "").strip(" -–—|:")
    trimmed = re.sub(r"^(?:apply (?:for|to)|how to apply (?:for|to)|grants?|funding|about)\s*[:—-]?\s+", "", name, flags=re.I)
    if not re.match(r"(?:for|from|to|of|in|on|and|with)\b", trimmed, re.I):
        name = trimmed  # "Funding for local charities from …" keeps its opening word
    name = re.sub(r"\s+(?:grant funding|grant application|funding programme|funding application|application form)$", "", name, flags=re.I)
    return name[:110].strip()


def guess_funder(page: dict, candidate: dict, host: str, sibling: dict | None = None) -> str:
    if candidate.get("funder"):
        return candidate["funder"]
    if sibling and sibling.get("funder"):
        return sibling["funder"]
    site_name = clean_title(page["site_name"].split("|")[0])
    if site_name and not GRANT_WORDS.fullmatch(site_name):
        return site_name[:80]
    named = FUNDER_SENTENCE.search(page["text"])
    if named:
        guess = clean_title(named.group(1))
        if 3 <= len(guess) <= 70:
            return guess
    title = page["title"]
    for separator in ("|", "–", "—", " - "):
        if separator in title:
            tail = title.split(separator)[-1].strip()
            if 3 <= len(tail) <= 60 and " " in tail and "." not in tail:
                return tail
    if page["h1"] and not BOILERPLATE_HEADING.match(page["h1"]) and len(page["h1"]) <= 80:
        return clean_title(page["h1"])[:80]
    base = host.split(".")[0].replace("-", " ")
    return base.title()[:80] or host


def guess_scope(text: str, candidate: dict, sibling: dict | None = None) -> tuple[str, str]:
    nations = {
        "Scotland": len(re.findall(r"\bscotland|scottish\b", text, re.I)),
        "Wales": len(re.findall(r"\bwales|welsh\b", text, re.I)),
        "Northern Ireland": len(re.findall(r"\bnorthern ireland\b", text, re.I)),
        "England": len(re.findall(r"\bengland\b", text, re.I)),
    }
    hits = [name for name, count in nations.items() if count >= 2]
    if len(hits) >= 2:
        return "UK-wide", "More than one UK nation is named on the funder's page."
    if len(hits) == 1:
        return hits[0], f"Projects in {hits[0]}"
    if re.search(r"\b(uk[- ]wide|across the uk|nationwide|throughout the uk)\b", text, re.I):
        return "UK-wide", "The page describes UK-wide reach."
    if candidate.get("scope_hint"):
        return candidate["scope_hint"], "Taken from a related programme by the same funder."
    if sibling and sibling.get("scope"):
        return sibling["scope"], f"Same reach as the other {sibling.get('funder', 'funder')} programme in this list."
    local = re.search(
        r"\b(?:residents of|based in|projects? in|working in|living in|only in|covering)\s+"
        r"((?:[A-Z][A-Za-z'.-]+)(?:\s+(?:and\s+)?[A-Z][A-Za-z'.-]+){0,2})",
        text,
    )
    if local:
        place = local.group(1).strip()
        if place in nations:
            return place, f"Projects in {place}"
        return "Regional / local", f"Area named on the page: {place}"
    return "UK-wide", "No geographic restriction is stated on the page."


def categories_for(text: str) -> list[str]:
    found = [name for name, pattern in CATEGORY_WORDS if re.search(pattern, text, re.I)]
    if not found:
        return ["Community"]
    return found[:4]


def decision_time(text: str) -> str:
    for line in text.splitlines():
        if DECISION_CUE.search(line):
            match = WEEKS_RE.search(line)
            if match:
                unit = match.group(3).lower().rstrip("s")
                low = match.group(1)
                high = match.group(2) or ""
                span = f"{low}–{high}" if high else low
                return f"~{span} {unit}{'s' if not high or high != '1' else ''}".strip()
    return "Not published"


def build_entry(page: dict, candidate: dict, index: dict, today: date) -> tuple[dict | None, str, dict]:
    """Turn a fetched candidate page into a fund entry. Returns (entry, reason, evidence)."""
    text = page["text"]
    host = registrable(urlsplit(page["final_url"]).netloc)
    siblings = [item for item in index["hosts"].get(host, []) if item.get("scope")]
    sibling = siblings[0] if siblings else None
    name = clean_name(page, candidate)
    funder = guess_funder(page, candidate, host, sibling)
    evidence = {
        "dates": [], "money": [], "lines": [],
        "fetched": page["final_url"], "title": page["title"],
    }

    if len(text) < MIN_TEXT:
        return None, "almost no readable text (JavaScript-rendered or a stub page)", evidence
    if not ORG_CUE.search(text):
        return None, "the page never mentions organisations, charities or community groups", evidence
    if INDIVIDUAL_CUE.search(text) and not ORG_ONLY_CUE.search(text):
        return None, "the page looks aimed at individuals rather than organisations", evidence
    if len(name) < 5 or len(name) > 110 or GRANT_WORDS.fullmatch(name):
        return None, f"the page title is too generic to name a fund ('{name or page['title']}')", evidence
    if NAME_BAD.search(name):
        return None, f"the page is guidance, an index or a sub-fund of a listed programme ('{name}')", evidence
    if BOILERPLATE_HEADING.match(name):
        return None, f"the page heading is site furniture, not a fund ('{name}')", evidence
    same_site_funds = 0
    for href, label in page["links"]:
        if programme_link(href, label, page["final_url"]):
            same_site_funds += 1
    if same_site_funds >= 5:
        return None, f"the page lists {same_site_funds} other programmes — it is a grants index, not one fund", evidence

    lookalike = similar_to_known(index, host, name)
    if lookalike:
        return None, f"looks like the existing entry “{lookalike}”", evidence

    closes = pick_deadline(text, today, DEADLINE_CUE)
    opens = pick_deadline(text, today, OPEN_CUE)
    closed = bool(CLOSED_CUE.search(text))
    rolling = bool(ROLLING_CUE.search(text))
    applying = bool(APPLY_CUE.search(text))
    money = money_values(text)

    if closes and closes >= today:
        deadline_type = "rounds" if re.search(r"\bround\b", text, re.I) else "fixed"
    elif closes:
        deadline_type = "closed"
    elif closed:
        deadline_type = "closed"
    elif rolling or applying:
        deadline_type = "rolling"
    else:
        deadline_type = "rolling"

    signals = sum(1 for flag in (bool(closes), bool(money), applying or rolling) if flag)
    if signals < 2:
        return None, "no deadline, no amount and no clear apply route on the page", evidence
    if deadline_type == "closed":
        return None, "the page describes a closed or paused round", evidence
    if opens and closes and opens >= closes:
        opens = None  # the page named one date; it is the deadline, not an opening

    money_cue = re.search(
        r"(up to|between|maximum|max\.|award(?:s)? of|grant(?:s)? of|typically|usually)",
        text, re.I,
    )
    if money:
        award_min = int(min(money))
        award_max = int(max(money))
    else:
        award_min = award_max = 0

    dates = [value.strftime("%Y-%m-%d") for value, _, _ in find_dates(text)][:8]
    evidence["dates"] = dates
    evidence["money"] = [f"£{int(v):,}" for v in money]
    evidence["lines"] = sentences(text, ORG_CUE, limit=2, min_len=40)

    eligibility = sentences(text, re.compile(
        r"(who can apply|eligib|apply if|you must|your organisation|we fund|open to|"
        r"applications? (?:are )?welcome|constituted)", re.I), limit=4)
    priorities = sentences(text, re.compile(r"(we fund|what we fund|funding priorities|themes|aims to|supports)", re.I), limit=4)
    steps = sentences(text, re.compile(r"(how to apply|apply (?:online|by|through)|application form|submit|deadline)", re.I), limit=4)

    if not eligibility:
        eligibility = ["The funder's page lists who can apply — read it before you start."]
    if not priorities:
        priorities = [f"Grants from {funder} — see the funder's page for themes."]
    if not steps:
        steps = ["Read the funder's guidance, then apply through the route on their page."]

    summary_source = page["description"] or (evidence["lines"][0] if evidence["lines"] else "")
    summary = clean_title(re.sub(r"\s+", " ", summary_source))
    if len(summary) < 40 or summary.isupper():
        summary = (sentences(text, GRANT_WORDS, limit=1) or [""])[0]
    if len(summary) < 40:
        summary = f"Found automatically from {funder}'s own page — open it for the current criteria and amounts."
    if len(summary) > 230:
        summary = summary[:227].rstrip() + "…"

    if closes and closes >= today:
        date_note = (
            f"The funder's page shows {closes.strftime('%d %B %Y')} as the closing date"
            + (f", with applications opening {opens.strftime('%d %B %Y')}." if opens and opens > today else ".")
        )
    elif rolling:
        date_note = "The funder's page describes an open, rolling programme with no closing date."
    else:
        date_note = "No closing date was found automatically — check the funder's page for the current round."

    description = " ".join(sentences(text, GRANT_WORDS, limit=3, width=400)) or summary[:600]

    effort = "Medium"
    if re.search(r"(simple|short application|easy to apply|brief form|two sides of a4|no long form)", text, re.I):
        effort = "Light"
    if re.search(r"(business plan|expression of interest|stage 1|stage one|full application|detailed proposal|due diligence)", text, re.I):
        effort = "Heavy"

    fund_id = slugify(name)
    if fund_id in index["ids"]:
        fund_id = slugify(f"{name}-{host.split('.')[0]}")
    suffix = 2
    while fund_id in index["ids"]:
        fund_id = slugify(f"{name}-{suffix}")
        suffix += 1

    scope, scope_detail = guess_scope(text, candidate, sibling)
    entry = {
        "id": fund_id,
        "name": name,
        "funder": funder,
        "fundingType": "Grant",
        "summary": summary,
        "description": description[:900],
        "categories": categories_for(text),
        "scope": scope,
        "scopeDetail": scope_detail,
        "awardMin": award_min,
        "awardMax": award_max,
        "awardNote": (
            f"£{award_min:,}–£{award_max:,} as published on the funder's page"
            if award_max and award_min and award_min != award_max
            else f"Up to £{award_max:,} as published on the funder's page" if award_max
            else "Award not published on the page the search found"
        ),
        "orgTypes": {
            "cic": org_status(text, r"\bCICs?\b|community interest compan"),
            "charity": org_status(text, r"\bcharit(?:y|ies|able)\b"),
            "nonprofit": org_status(text, r"not[- ]for[- ]profit|non[- ]profit|constituted (?:community )?group|community group|voluntary (?:and|or) community|social enterprise"),
        },
        "eligibility": eligibility,
        "priorities": priorities,
        "applicationSteps": steps,
        "tips": [
            "This entry was found automatically by reading the funder's page, so the detail is thin: open the source and confirm the round, amounts and criteria before you spend time on it.",
        ],
        "opens": opens.strftime("%Y-%m-%d") if opens and opens > today else None,
        "closes": closes.strftime("%Y-%m-%d") if closes and closes >= today else None,
        "deadlineType": deadline_type,
        "dateNote": date_note,
        "decisionTime": decision_time(text),
        "effort": effort,
        "applyUrl": page["final_url"],
        "sourceUrl": page["final_url"],
        "origin": "auto",
        "discovered": today.isoformat(),
        "discoveredVia": candidate["seed"],
        "verified": today.isoformat(),
        "confidence": "check",
    }
    charity_no = CHARITY_NO_RE.search(text)
    if charity_no:
        entry["charityNo"] = charity_no.group(1)
    reason = (
        f"open programme on {host}"
        + (f", closes {entry['closes']}" if entry["closes"] else ", rolling")
        + (f", {entry['awardNote'].lower()}" if entry["awardMax"] else "")
    )
    if money_cue and not money:
        reason += " (amount wording found but no figure parsed)"
    return entry, reason, evidence


# --------------------------------------------------------------------------- #
# Writing to js/data.js
# --------------------------------------------------------------------------- #

def js_str(value: str) -> str:
    text = str(value).replace("\\", "\\\\").replace("'", "\\'")
    text = text.replace("\r", " ").replace("\n", " ")
    return "'" + text + "'"


def js_field(indent: str, key: str, value: str) -> list[str]:
    line = f"{indent}{key}: {value},"
    if len(line) <= 110:
        return [line]
    return [f"{indent}{key}:", f"{indent}  {value},"]


def js_list(indent: str, key: str, items: list[str]) -> list[str]:
    if not items:
        return [f"{indent}{key}: [],"]
    lines = [f"{indent}{key}: ["]
    lines += [f"{indent}  {js_str(item)}," for item in items]
    lines.append(f"{indent}],")
    return lines


def render_entry(entry: dict) -> str:
    lines = ["  {"]
    for key in ("id", "name", "funder", "fundingType"):
        lines += js_field("    ", key, js_str(str(entry[key])))
    lines += js_field("    ", "summary", js_str(entry["summary"]))
    lines += js_field("    ", "description", js_str(entry["description"]))
    lines += js_list("    ", "categories", entry["categories"])
    lines += js_field("    ", "scope", js_str(entry["scope"]))
    lines += js_field("    ", "scopeDetail", js_str(entry["scopeDetail"]))
    lines.append(f"    awardMin: {entry['awardMin']},")
    lines.append(f"    awardMax: {entry['awardMax']},")
    lines += js_field("    ", "awardNote", js_str(entry["awardNote"]))
    org = entry["orgTypes"]
    lines.append(
        "    orgTypes: { cic: %s, charity: %s, nonprofit: %s },"
        % (js_str(org["cic"]), js_str(org["charity"]), js_str(org["nonprofit"]))
    )
    lines += js_list("    ", "eligibility", entry["eligibility"])
    lines += js_list("    ", "priorities", entry["priorities"])
    lines += js_list("    ", "applicationSteps", entry["applicationSteps"])
    lines += js_list("    ", "tips", entry["tips"])
    lines.append(f"    opens: {js_str(entry['opens']) if entry['opens'] else 'null'},")
    lines.append(f"    closes: {js_str(entry['closes']) if entry['closes'] else 'null'},")
    lines += js_field("    ", "deadlineType", js_str(entry["deadlineType"]))
    lines += js_field("    ", "dateNote", js_str(entry["dateNote"]))
    lines += js_field("    ", "decisionTime", js_str(entry["decisionTime"]))
    lines += js_field("    ", "effort", js_str(entry["effort"]))
    lines += js_field("    ", "applyUrl", js_str(entry["applyUrl"]))
    lines += js_field("    ", "sourceUrl", js_str(entry["sourceUrl"]))
    if entry.get("charityNo"):
        lines += js_field("    ", "charityNo", js_str(entry["charityNo"]))
    lines += js_field("    ", "origin", js_str(entry["origin"]))
    lines += js_field("    ", "discovered", js_str(entry["discovered"]))
    lines += js_field("    ", "discoveredVia", js_str(entry["discoveredVia"]))
    lines += js_field("    ", "verified", js_str(entry["verified"]))
    lines += js_field("    ", "confidence", js_str(entry["confidence"]))
    lines.append("  },")
    return "\n".join(lines)


def append_entries(entries: list[dict]) -> None:
    raw = DATA_FILE.read_bytes()
    crlf = b"\r\n" in raw[:8000]
    source = raw.decode("utf-8").replace("\r\n", "\n")
    marker = "\n];\n\nconst CATEGORIES"
    if marker not in source:
        raise SystemExit("could not find the end of the FUNDS array in js/data.js")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copyfile(DATA_FILE, BACKUP_DIR / f"data-{stamp}.js")
    old = sorted(BACKUP_DIR.glob("data-*.js"))
    for path in old[:-BACKUPS_KEPT]:
        path.unlink(missing_ok=True)

    block = "\n".join(render_entry(entry) for entry in entries)
    source = source.replace(marker, f"\n{block}{marker}", 1)
    out = source.replace("\n", "\r\n") if crlf else source
    DATA_FILE.write_bytes(out.encode("utf-8"))


def write_new_funds_file(entries: list[dict], today: date) -> None:
    """Publish this run's additions so the app can show them without a reload.

    The same entries are in js/data.js permanently; this small file only carries
    the most recent run, so it never grows.
    """
    header = [
        "/* Funds found automatically by tools/discover.py — most recent run only.",
        f"   Discovered {today.isoformat()}. The same entries are in js/data.js. */",
        "",
        "window.FUNDS_AUTO = [",
    ]
    body = [] if not entries else [render_entry(entry) for entry in entries]
    lines = header + body + ["];", ""]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    NEW_FUNDS_FILE.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Ledger
# --------------------------------------------------------------------------- #

def read_ledger() -> dict:
    try:
        data = json.loads(DISCOVERY_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("candidates"), dict):
            for record in data["candidates"].values():
                # Ledgers written before the cap was tracked: a candidate that
                # passed but missed the per-run limit should be retried next run.
                if "over this run's cap" in (record.get("reason") or ""):
                    record["over_cap"] = True
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {"candidates": {}}


def prune_ledger(ledger: dict, today: date) -> dict:
    kept = {}
    for url, record in ledger.get("candidates", {}).items():
        stamp = record.get("last_checked") or record.get("first_seen") or ""
        try:
            when = datetime.fromisoformat(stamp).date()
        except ValueError:
            kept[url] = record
            continue
        if (today - when).days < LEDGER_DAYS:
            kept[url] = record
    ledger["candidates"] = kept
    return ledger


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(description="Find grant programmes missing from js/data.js.")
    parser.add_argument("--dry-run", action="store_true", help="report only; never edit js/data.js")
    parser.add_argument("--max-new", type=int, default=MAX_NEW_PER_RUN, help=f"most funds to add in one run (default {MAX_NEW_PER_RUN})")
    parser.add_argument("--timeout", type=float, default=20.0, help="per-page timeout in seconds (default 20)")
    parser.add_argument("--jobs", type=int, default=6, help="parallel requests (default 6)")
    parser.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES, help=f"most candidate pages to read per run (default {MAX_CANDIDATES})")
    parser.add_argument("--verbose", action="store_true", help="list every candidate page before reading it")
    parser.add_argument("--skip-sweep", action="store_true", help="use only the directory seeds, not the pages already monitored")
    args = parser.parse_args()

    if not DATA_FILE.exists():
        print(f"error: {DATA_FILE} not found", file=sys.stderr)
        return 1

    today = date.today()
    now = datetime.now(timezone.utc)
    verified, funds = load_funds()
    index = dataset_index(funds)
    ledger = read_ledger()
    ledger = prune_ledger(ledger, today)

    seeds = [seed for seed in seed_pages(funds) if not (args.skip_sweep and seed["fund"])]
    print(f"Searching {len(seeds)} page{'s' if len(seeds) != 1 else ''} for links to programmes "
          f"that are not in the dataset ({len(funds)} entries)…")

    pages: dict[str, dict] = {}
    seed_failures: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(fetch, seed["url"], args.timeout): seed for seed in seeds}
        for future in as_completed(futures):
            seed = futures[future]
            page = future.result()
            pages[seed["url"]] = page
            if not page["ok"]:
                seed_failures.append(f"{seed['url']} — {page['error']}")

    candidates = collect_candidates(seeds, pages, index, ledger["candidates"], today)
    total_candidates = len(candidates)
    candidates = spread_candidates(candidates, args.max_candidates)
    print(f"  {len(candidates)} candidate programme page{'s' if len(candidates) != 1 else ''} to read"
          + (f" (of {total_candidates} found)" if total_candidates > len(candidates) else ""))
    if args.verbose:
        for candidate in candidates:
            print(f"    [{candidate['origin']:<9}] {candidate['url']}  «{candidate['label']}»  from {candidate['seed']}")

    entries: list[dict] = []
    queued: list[dict] = []
    rejected: list[dict] = []
    unreadable = 0

    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(fetch, candidate["url"], args.timeout): candidate for candidate in candidates}
        results = {}
        for future in as_completed(futures):
            candidate = futures[future]
            results[candidate["url"]] = future.result()

    for candidate in candidates:
        page = results[candidate["url"]]
        url = candidate["url"]
        if not page["ok"]:
            unreadable += 1
            rejected.append({**candidate, "reason": f"could not be read: {page['error']}"})
            ledger["candidates"][url] = {
                "status": "rejected", "reason": f"could not be read: {page['error']}",
                "label": candidate["label"], "seed": candidate["seed"],
                "first_seen": ledger["candidates"].get(url, {}).get("first_seen") or now.isoformat(timespec="seconds"),
                "last_checked": now.isoformat(timespec="seconds"),
            }
            continue
        entry, reason, evidence = build_entry(page, candidate, index, today)
        stamp = ledger["candidates"].get(url, {}).get("first_seen") or now.isoformat(timespec="seconds")
        if entry:
            entries.append({**entry, "_reason": reason, "_evidence": evidence})
        elif evidence["dates"] or evidence["money"]:
            # Something real is on the page: a human should decide about it.
            queued.append({**candidate, "reason": reason, "evidence": evidence, "first_seen": stamp})
        else:
            rejected.append({**candidate, "reason": reason})

    added = entries[: max(0, args.max_new)]
    over_cap = entries[max(0, args.max_new):]
    for item in over_cap:
        queued.append({**{k: v for k, v in item.items() if not k.startswith("_")},
                       "url": item["sourceUrl"],
                       "seed": item["discoveredVia"],
                       "label": item["name"],
                       "reason": "passed the checks but went over this run's cap — queued",
                       "over_cap": True,
                       "evidence": item["_evidence"],
                       "first_seen": ledger["candidates"].get(item["sourceUrl"], {}).get("first_seen")
                       or now.isoformat(timespec="seconds")})

    if added and not args.dry_run:
        clean_added = [{k: v for k, v in item.items() if not k.startswith("_")} for item in added]
        append_entries(clean_added)
        write_new_funds_file(clean_added, today)
    elif not args.dry_run:
        write_new_funds_file([], today)

    stamp_now = now.isoformat(timespec="seconds")
    for item in added:
        ledger["candidates"][item["sourceUrl"]] = {
            "status": "planned" if args.dry_run else "added",
            "id": item["id"], "name": item["name"], "funder": item["funder"],
            "seed": item["discoveredVia"], "reason": item["_reason"],
            "first_seen": ledger["candidates"].get(item["sourceUrl"], {}).get("first_seen") or stamp_now,
            "last_checked": stamp_now,
        }
    for item in queued:
        ledger["candidates"][item["url"]] = {
            "status": "queued", "name": item.get("name") or item.get("label"), "reason": item["reason"],
            "seed": item["seed"], "first_seen": item.get("first_seen") or stamp_now,
            "last_checked": stamp_now, "over_cap": bool(item.get("over_cap")),
        }
    for item in rejected:
        ledger["candidates"][item["url"]] = {
            "status": "rejected", "reason": item["reason"], "label": item["label"],
            "seed": item["seed"],
            "first_seen": ledger["candidates"].get(item["url"], {}).get("first_seen") or stamp_now,
            "last_checked": stamp_now,
        }

    ledger["last_run"] = stamp_now
    ledger["added_total"] = len([c for c in ledger["candidates"].values() if c.get("status") == "added"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DISCOVERY_FILE.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")

    print()
    for item in added:
        print(f"  ADDED   {item['name']} ({item['funder']}) — {item['_reason']}")
    for item in queued[:12]:
        print(f"  queued  {item.get('name') or item.get('label')} — {item['reason']}")
    if len(queued) > 12:
        print(f"  … {len(queued) - 12} more queued")
    print(f"  {unreadable} candidate page(s) could not be read · "
          f"{len(rejected) - unreadable} did not look like a fund")
    if seed_failures:
        print(f"  {len(seed_failures)} seed page(s) did not load")
        for failure in seed_failures[:5]:
            print(f"    {failure}")
    if args.dry_run:
        print("dry run: js/data.js was not touched")
    print(f"{len(added)} added · {len(queued)} queued · ledger: {DISCOVERY_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
