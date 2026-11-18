#!/usr/bin/env python3
"""Check every grant's source page for changes.

The dataset in js/data.js is a frozen snapshot. This script fetches each
`sourceUrl`, extracts readable text, compares it with the previous run and
writes a review report. It never edits the dataset: a changed page is a
prompt to look, not proof that a deadline moved.

    python3 tools/check_sources.py
    python3 tools/check_sources.py --only garfield-weston rosa-voices-frontline

Outputs (all under data-check/):
    report-YYYY-MM-DD.md   human review notes for today's run
    state.json             last HTTP status, title and content hash per fund,
                           plus the unreviewed changes still worth showing
    latest.json            the same result as compact JSON for the app
    snapshots/<id>.txt.gz  normalised page text, kept so the next run can diff

A change is written to a pending ledger as well, because the next run replaces
the snapshot it was diffed against — without the ledger a reload would show
"nothing changed" seconds after a change was found. Pending entries last
PENDING_DAYS and stay until they are acknowledged:

    python3 tools/check_sources.py --ack doyly-carte

Exit code is 1 if any page could not be fetched, 0 otherwise.
"""

from __future__ import annotations

import argparse
import difflib
import gzip
import hashlib
import json
import re
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "js" / "data.js"
OUT_DIR = ROOT / "data-check"
SNAPSHOT_DIR = OUT_DIR / "snapshots"
STATE_FILE = OUT_DIR / "state.json"
LATEST_FILE = OUT_DIR / "latest.json"
PENDING_DAYS = 30

USER_AGENT = "CommunityFundingFinderDataCheck/1.0 (manual grant data review)"
MAX_BYTES = 4 * 1024 * 1024
BLOCK_TAGS = {
    "p", "div", "li", "ul", "ol", "br", "tr", "td", "th", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6", "table", "dd", "dt", "blockquote", "figure",
}
SKIP_TAGS = {
    "script", "style", "noscript", "svg", "nav", "header", "footer", "aside",
    "form", "iframe", "template", "button", "select", "option",
}
FIELDS = ("id", "name", "funder", "sourceUrl", "applyUrl", "closes", "opens",
          "deadlineType", "scope", "confidence", "verified", "origin", "discovered")

DATE_RE = re.compile(
    r"\b(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d{2}"
    r"|20\d{2}-\d{2}-\d{2}"
    r"|\d{1,2}/\d{1,2}/20\d{2})\b",
    re.I,
)
MONEY_RE = re.compile(r"£\s?\d[\d,]*(?:\.\d+)?\s?(?:million|m|k|thousand)?", re.I)
KEYWORD_RE = re.compile(
    r"\b(deadline|clos(?:e|es|ed|ing)|open(?:s|ed|ing)?|apply by|round|rolling|"
    r"paused|suspend(?:ed|ing)?|no longer)\b",
    re.I,
)


def dedupe(values: list[str]) -> list[str]:
    seen: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return seen


def pending_from_state(state: dict, keep: set[str]) -> dict[str, dict]:
    """Unreviewed changes from earlier runs, dropping unknown and stale entries."""
    pending: dict[str, dict] = {}
    for entry in state.get("pending", []):
        if not isinstance(entry, dict) or entry.get("id") not in keep:
            continue
        try:
            first_seen = datetime.fromisoformat(entry["first_seen"])
        except (KeyError, ValueError, TypeError):
            continue
        if (datetime.now(timezone.utc) - first_seen).days >= PENDING_DAYS:
            continue
        pending[entry["id"]] = entry
    return pending


def read_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def acknowledge(ids: list[str]) -> int:
    state = read_state()
    if not state:
        print("error: no source check has run yet", file=sys.stderr)
        return 1
    wanted = set(ids)
    before = len(state.get("pending", []))
    state["pending"] = [p for p in state.get("pending", []) if p.get("id") not in wanted]
    removed = before - len(state["pending"])
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    if LATEST_FILE.exists():
        try:
            latest = json.loads(LATEST_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            latest = None
        if isinstance(latest, dict):
            latest["pending"] = state["pending"]
            latest["pending_total"] = len(state["pending"])
            LATEST_FILE.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")
    print(f"marked {removed} change{'s' if removed != 1 else ''} as reviewed")
    return 0


def unescape_js(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


def load_funds() -> tuple[str, list[dict]]:
    src = DATA_FILE.read_text(encoding="utf-8")
    verified_match = re.search(r"const VERIFIED = '([^']+)'", src)
    verified = verified_match.group(1) if verified_match else ""

    funds = []
    for block in re.finditer(r"\n  \{\n(.*?)\n  \},", src, re.S):
        # The first field has no leading newline inside the captured block.
        body = "\n" + block.group(1)
        fund = {}
        for field in FIELDS:
            match = re.search(
                r"\n    " + field + r":\s*'((?:[^'\\]|\\.)*)'", body
            )
            if match:
                fund[field] = unescape_js(match.group(1))
        if fund.get("id") and fund.get("sourceUrl"):
            funds.append(fund)
    return verified, funds


class PageText(HTMLParser):
    """Readable text plus <title>, first heading, metadata and outbound links.

    ``links`` and ``description`` are used by tools/discover.py to look for grant
    programme pages; the source check itself only reads ``title`` and ``text``.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.h1 = ""
        self.description = ""
        self.site_name = ""
        self.links: list[tuple[str, str]] = []
        self._in_title = False
        self._in_h1 = False
        self._skip_depth = 0
        self._anchor: tuple[str, list[str]] | None = None
        self._chunks: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "h1":
            self._in_h1 = True
        if tag == "meta":
            key = (attrs.get("name") or attrs.get("property") or "").lower()
            content = clean_title(attrs.get("content") or "")
            if content and key in ("description", "og:description", "twitter:description"):
                self.description = self.description or content
            elif content and key in ("og:site_name", "application-name"):
                self.site_name = self.site_name or content
        if tag == "a" and self._skip_depth == 0 and attrs.get("href"):
            self._anchor = (attrs["href"], [])
        if tag in SKIP_TAGS:
            self._skip_depth += 1
        if tag in BLOCK_TAGS and self._chunks:
            self._chunks.append("\n")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag == "meta":
            return
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "h1":
            self._in_h1 = False
        if tag == "a" and self._anchor is not None:
            href, parts = self._anchor
            self._anchor = None
            label = clean_title(" ".join(parts))
            if label:
                self.links.append((href, label))
        if tag in SKIP_TAGS and self._skip_depth:
            self._skip_depth -= 1
        if tag in BLOCK_TAGS:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
            return
        if self._anchor is not None and self._skip_depth == 0:
            self._anchor[1].append(data)
        if self._skip_depth:
            return
        if self._in_h1:
            self.h1 += data
        self._chunks.append(data)

    def text(self) -> str:
        raw = "".join(self._chunks).replace("\u00a0", " ")
        lines = []
        for line in raw.splitlines():
            line = re.sub(r"[ \t\r\f\v]+", " ", line).strip()
            if line:
                lines.append(line)
        return "\n".join(lines)


def clean_title(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def check_fund(fund: dict, timeout: float) -> dict:
    url = fund["sourceUrl"]
    result = {
        "id": fund["id"],
        "name": fund.get("name", fund["id"]),
        "funder": fund.get("funder", ""),
        "url": url,
        "status": None,
        "ok": False,
        "blocked": False,
        "error": "",
        "final_url": url,
        "title": "",
        "hash": "",
        "text": None,
        "content_type": "",
        "note": "",
    }
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            result["status"] = response.status
            result["final_url"] = response.geturl()
            content_type = response.headers.get_content_type()
            result["content_type"] = content_type
            charset = response.headers.get_content_charset() or "utf-8"
            raw = response.read(MAX_BYTES)
    except HTTPError as exc:
        result["status"] = exc.code
        result["blocked"] = exc.code in (401, 403, 429)
        result["error"] = f"HTTP {exc.code} {exc.reason}"
        return result
    except (URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        result["error"] = f"connection failed: {reason}"
        return result
    except Exception as exc:  # one bad page must not end the run
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result

    result["ok"] = True
    if "html" in content_type or "xml" in content_type:
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
        text = unicodedata.normalize("NFKC", parser.text())
        result["title"] = clean_title(parser.title)
        result["text"] = text
        result["hash"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if len(text) < 200:
            result["note"] = "almost no readable text (may be JavaScript-rendered)"
    else:
        result["hash"] = hashlib.sha256(raw).hexdigest()
        result["note"] = f"not HTML ({content_type}); compared as raw bytes"
    return result


def read_snapshot(fund_id: str) -> str | None:
    path = SNAPSHOT_DIR / f"{fund_id}.txt.gz"
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            return handle.read()
    except (OSError, EOFError, UnicodeDecodeError):
        return None


def write_snapshot(fund_id: str, text: str) -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(SNAPSHOT_DIR / f"{fund_id}.txt.gz", "wt", encoding="utf-8") as handle:
        handle.write(text)


def diff_text(old: str, new: str, limit: int = 80) -> tuple[list[str], list[str], bool]:
    """Return notable added and removed lines, capped, plus a truncation flag."""
    old_lines, new_lines = old.splitlines(), new.splitlines()
    added: list[str] = []
    removed: list[str] = []
    for line in difflib.unified_diff(old_lines, new_lines, n=0, lineterm=""):
        if line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
            continue
        if line.startswith("+"):
            value = line[1:].strip()
            if value and value not in added:
                added.append(value)
        elif line.startswith("-"):
            value = line[1:].strip()
            if value and value not in removed:
                removed.append(value)
    truncated = len(added) > limit or len(removed) > limit
    return added[:limit], removed[:limit], truncated


def signals(added: list[str]) -> tuple[list[str], list[str], list[str]]:
    dates: list[str] = []
    money: list[str] = []
    lines: list[str] = []
    for line in added:
        if not (KEYWORD_RE.search(line) or DATE_RE.search(line)):
            continue
        if len(line) > 280:
            line = line[:277].rstrip() + "…"
        if line not in lines:
            lines.append(line)
    blob = "\n".join(added)
    for token in DATE_RE.findall(blob):
        if token not in dates:
            dates.append(token)
    for token in MONEY_RE.findall(blob):
        token = token.strip()
        if token not in money:
            money.append(token)
    return lines[:10], dates[:8], money[:8]


def deadline_state(fund: dict, today: date) -> tuple[str, str]:
    closes = (fund.get("closes") or "").strip()
    deadline_type = (fund.get("deadlineType") or "").strip()
    if not closes:
        return deadline_type or "no date", ""
    try:
        close_date = datetime.strptime(closes, "%Y-%m-%d").date()
    except ValueError:
        return closes, "unreadable deadline in dataset"
    if close_date < today and deadline_type not in ("closed", "announced"):
        days = (today - close_date).days
        return closes, f"deadline passed {days} day{'s' if days != 1 else ''} ago"
    return closes, ""


def md_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> int:
    parser = argparse.ArgumentParser(description="Diff funder source pages against the last run.")
    parser.add_argument("--only", nargs="+", metavar="ID", help="check only these fund ids")
    parser.add_argument("--ack", nargs="+", metavar="ID", help="mark these changes reviewed and exit")
    parser.add_argument("--timeout", type=float, default=20.0, help="per-page timeout in seconds (default 20)")
    parser.add_argument("--jobs", type=int, default=4, help="parallel requests (default 4)")
    args = parser.parse_args()

    if args.ack:
        return acknowledge(args.ack)

    if not DATA_FILE.exists():
        print(f"error: {DATA_FILE} not found", file=sys.stderr)
        return 1

    verified, funds = load_funds()
    all_funds = funds
    if args.only:
        wanted = set(args.only)
        unknown = wanted - {fund["id"] for fund in funds}
        if unknown:
            print(f"error: unknown fund id(s): {', '.join(sorted(unknown))}", file=sys.stderr)
            return 1
        funds = [fund for fund in funds if fund["id"] in wanted]
    if not funds:
        print("error: no funds to check", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    state_before = read_state()
    previous = state_before.get("checks", {})
    pending = pending_from_state(state_before, {fund["id"] for fund in all_funds})

    today = date.today()
    now = datetime.now(timezone.utc)
    results: dict[str, dict] = {}
    print(f"Checking {len(funds)} source page{'s' if len(funds) != 1 else ''}…")
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(check_fund, fund, args.timeout): fund for fund in funds}
        for future in as_completed(futures):
            fund = futures[future]
            result = future.result()
            old_text = read_snapshot(fund["id"])
            last = previous.get(fund["id"], {})
            added: list[str] = []
            removed: list[str] = []
            truncated = False

            if not result["ok"]:
                result["change"] = "blocked" if result["blocked"] else "unreachable"
            elif not last.get("hash"):
                result["change"] = "baseline"
            elif last.get("hash") == result["hash"]:
                result["change"] = "unchanged"
            else:
                result["change"] = "changed"

            if result["change"] == "changed" and old_text and result["text"] is not None:
                added, removed, truncated = diff_text(old_text, result["text"])
            result["added"] = added
            result["removed"] = removed
            result["truncated"] = truncated
            result["signals"], result["dates"], result["money"] = signals(added)

            if result["text"] is not None:
                write_snapshot(fund["id"], result["text"])
            if last.get("title") and result["title"] and last["title"] != result["title"]:
                result["title_changed"] = True
            else:
                result["title_changed"] = False
            if result["final_url"] != result["url"]:
                result["note"] = (result["note"] + "; " if result["note"] else "") + "redirected"

            results[fund["id"]] = result
            mark = {
                "changed": "CHANGED", "baseline": "baseline", "unchanged": "ok",
                "blocked": "BLOCKED", "unreachable": "FAILED",
            }[result["change"]]
            detail = result["error"] or result["note"]
            print(f"  {mark:<8} {fund['id']:<34} {detail}".rstrip())

    ordered = [results[fund["id"]] for fund in funds]
    counts = {name: sum(1 for r in ordered if r["change"] == name)
              for name in ("changed", "baseline", "unchanged", "blocked", "unreachable")}

    # Record changes in the pending ledger. The snapshot has already been
    # replaced above, so without this the next run would report "unchanged" and
    # the change would disappear from the page on reload.
    for result in ordered:
        if result["change"] != "changed":
            continue
        entry = pending.get(result["id"]) or {
            "id": result["id"],
            "first_seen": now.isoformat(timespec="seconds"),
            "runs": 0,
            "dates": [],
            "money": [],
            "signals": [],
        }
        entry.update({
            "name": result["name"],
            "funder": result["funder"],
            "url": result["url"],
            "last_seen": now.isoformat(timespec="seconds"),
            "runs": int(entry.get("runs", 0)) + 1,
            "dates": dedupe(list(entry.get("dates", [])) + result["dates"])[:8],
            "money": dedupe(list(entry.get("money", [])) + result["money"])[:8],
            "signals": result["signals"] or entry.get("signals", []),
            "title_changed": bool(result["title_changed"]),
        })
        pending[result["id"]] = entry

    # Dataset-level staleness and deadline inconsistencies are reported whether
    # or not the page itself changed.
    stale_deadlines = []
    for fund in funds:
        close, problem = deadline_state(fund, today)
        if problem:
            stale_deadlines.append((fund, close, problem))

    verified_age = None
    if verified:
        try:
            verified_age = (today - datetime.strptime(verified, "%Y-%m-%d").date()).days
        except ValueError:
            verified_age = None

    run_stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    lines: list[str] = []
    lines.append(f"# Source check — {today.day} {today.strftime('%B %Y')}")
    lines.append("")
    source_word = "source" if len(ordered) == 1 else "sources"
    lines.append(
        f"Run {run_stamp} · {len(ordered)} {source_word} · "
        f"{counts['changed']} changed · {counts['blocked']} blocked · "
        f"{counts['unreachable']} unreachable"
    )
    if verified:
        age = f"{verified_age} days old" if verified_age is not None else "age unknown"
        warning = ""
        if verified_age is not None and verified_age > 30:
            warning = " — **re-verify before relying on this data**"
        lines.append(f"Dataset verified {verified} ({age}){warning}")
    lines.append("")

    attention = []
    for result in ordered:
        if result["change"] == "blocked":
            attention.append(
                f"**{result['name']}** — site refused an automated request ({result['error']}); open it manually"
            )
        elif result["change"] == "unreachable":
            attention.append(f"**{result['name']}** — source did not load: {result['error']}")
        elif result["change"] == "changed":
            attention.append(f"**{result['name']}** — page changed; review the excerpt below")
    for fund, close, problem in stale_deadlines:
        attention.append(f"**{fund.get('name', fund['id'])}** — {problem} (closes {close})")
    if attention:
        lines.append("## Review first")
        lines.append("")
        for item in attention:
            lines.append(f"- {item}")
        lines.append("")
    else:
        lines.append("## Review first")
        lines.append("")
        lines.append("Nothing needs attention: every source loaded and matched the last run.")
        lines.append("")

    if counts["changed"]:
        lines.append("## Changed pages")
        lines.append("")
        for result in ordered:
            if result["change"] != "changed":
                continue
            lines.append(f"### {result['name']}")
            lines.append("")
            lines.append(f"- Funder: {result['funder'] or 'unknown'}")
            lines.append(f"- Source: {result['url']}")
            lines.append(f"- Status: HTTP {result['status']} · title: {result['title'] or 'none'}")
            if result.get("title_changed"):
                lines.append("- **Page title changed**")
            sig_lines, dates, money = result["signals"], result["dates"], result["money"]
            if dates:
                lines.append(f"- Dates mentioned in added text: {', '.join(dates)}")
            if money:
                lines.append(f"- Amounts mentioned in added text: {', '.join(money)}")
            lines.append("")
            if sig_lines:
                lines.append("Lines that mention dates, rounds or eligibility:")
                lines.append("")
                for item in sig_lines:
                    lines.append(f"> {md_cell(item)}")
                    lines.append(">")
                if lines[-1] == ">":
                    lines.pop()
                lines.append("")
            if result["added"]:
                lines.append("Added text (first 20 lines):")
                lines.append("")
                lines.append("```")
                lines.extend(result["added"][:20])
                if result["truncated"]:
                    lines.append("… diff truncated; see the snapshot for the full page")
                lines.append("```")
                lines.append("")
            if result["removed"]:
                lines.append("Removed text (first 10 lines):")
                lines.append("")
                lines.append("```")
                lines.extend(result["removed"][:10])
                lines.append("```")
                lines.append("")
            if not result["added"] and not result["removed"]:
                lines.append(
                    "Content hash changed but no line-level diff was available "
                    "(first run for this page, or a non-text response)."
                )
                lines.append("")

    lines.append("## All sources")
    lines.append("")
    lines.append("| Fund | Result | Deadline in data | Note |")
    lines.append("| --- | --- | --- | --- |")
    for result in ordered:
        fund = next(f for f in funds if f["id"] == result["id"])
        close, problem = deadline_state(fund, today)
        label = {
            "changed": "**changed**", "baseline": "baseline", "unchanged": "unchanged",
            "blocked": "**blocked**", "unreachable": "**unreachable**",
        }[result["change"]]
        note = result["error"] or result["note"] or ""
        if problem:
            note = (note + "; " if note else "") + problem
        lines.append(
            f"| [{md_cell(result['name'])}]({result['url']}) | {label} | "
            f"{md_cell(close) or '—'} | {md_cell(note) or '—'} |"
        )
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(
        "A change here means the page text differs from the last run. It does not prove a "
        "deadline moved: funders edit news, banners and staff lists too. Open the source, "
        "confirm the round and dates, then update `js/data.js` and the `VERIFIED` date by hand."
    )
    lines.append("")

    # A partial run writes its own file so it cannot replace the day's full report.
    suffix = "-partial" if args.only else ""
    report_path = OUT_DIR / f"report-{today.isoformat()}{suffix}.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")

    # Merge with the previous state so a --only run does not forget the rest.
    checks = dict(previous)
    for result in ordered:
        checks[result["id"]] = {
            "url": result["url"],
            "checked": now.isoformat(timespec="seconds"),
            "status": result["status"],
            "ok": result["ok"],
            "final_url": result["final_url"],
            "title": result["title"],
            "hash": result["hash"],
            "content_type": result["content_type"],
        }
    keep = {fund["id"] for fund in all_funds}
    pending_list = sorted(pending.values(), key=lambda e: e.get("last_seen", ""), reverse=True)
    # Keep every other key that is already in the file — the daily update records
    # its own run here ("daily", "daily_history") and must not lose it when a
    # source check rewrites the file moments later.
    state = {
        key: value for key, value in state_before.items()
        if key not in {"last_run", "verified", "checks", "pending"}
    }
    state.update({
        "last_run": now.isoformat(timespec="seconds"),
        "verified": verified,
        "checks": {fund_id: value for fund_id, value in checks.items() if fund_id in keep},
        "pending": pending_list,
    })
    STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    # Machine-readable result for the app's "check sources" button. Only the
    # rows that need a human (changed, new, blocked, stale deadlines) are kept
    # small enough to render in the browser.
    latest = {
        "run_at": now.isoformat(timespec="seconds"),
        "date": today.isoformat(),
        "verified": verified,
        "verified_age_days": verified_age,
        "partial": bool(args.only),
        "report": report_path.name,
        "total": len(ordered),
        "counts": counts,
        "pending_total": len(pending_list),
        "pending": pending_list,
        "items": [
            {
                "id": r["id"],
                "name": r["name"],
                "funder": r["funder"],
                "url": r["url"],
                "change": r["change"],
                "status": r["status"],
                "error": r["error"],
                "note": r["note"],
                "title_changed": r["title_changed"],
                "dates": r["dates"],
                "money": r["money"],
                "signals": r["signals"],
                "added": r["added"][:6],
                "removed": r["removed"][:4],
            }
            for r in ordered
            if r["change"] != "unchanged"
        ],
        "stale": [
            {"id": fund["id"], "name": fund.get("name", fund["id"]), "closes": close, "problem": problem}
            for fund, close, problem in stale_deadlines
        ],
    }
    LATEST_FILE.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")

    print()
    print(
        f"{counts['changed']} changed · {counts['baseline']} baseline · "
        f"{counts['unchanged']} unchanged · {counts['blocked']} blocked · "
        f"{counts['unreachable']} unreachable"
    )
    if stale_deadlines:
        print(f"{len(stale_deadlines)} deadline(s) in the dataset are already in the past")
    print(f"report: {report_path.relative_to(ROOT)}")
    return 1 if counts["unreachable"] or counts["blocked"] else 0


if __name__ == "__main__":
    sys.exit(main())
