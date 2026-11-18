#!/usr/bin/env python3
"""The daily update: look for new funds, then re-check every monitored source.

One command, run by tools/serve.py while it is open (and by a scheduled task if
you set one up):

    1. tools/discover.py    sweeps the pages already monitored and a few public
                            directories, appends the programmes that pass its
                            checks to js/data.js and queues the rest;
    2. tools/check_sources.py diffs every source page — including the pages just
                            added, so they get their first snapshot;
    3. writes data-check/daily.json for the app and records the run in state.json.

    python3 tools/daily.py                  # full daily update
    python3 tools/daily.py --skip-discovery # source check only
    python3 tools/daily.py --skip-check     # find new funds only
    python3 tools/daily.py --dry-run        # find new funds without writing them

Exit code is 1 if a fund could not be added and the check failed, 0 otherwise.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
OUT_DIR = ROOT / "data-check"
STATE_FILE = OUT_DIR / "state.json"
LATEST_FILE = OUT_DIR / "latest.json"
DISCOVERY_FILE = OUT_DIR / "discovery.json"
DAILY_FILE = OUT_DIR / "daily.json"
QUEUED_IN_PAYLOAD = 8


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def run(script: str, extra: list[str] | None = None) -> tuple[int, list[str]]:
    command = [sys.executable, str(TOOLS / script), *(extra or [])]
    print(f"$ {' '.join(Path(part).name if part.endswith('.py') else part for part in command[1:])}")
    try:
        proc = subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True, timeout=900)
    except subprocess.TimeoutExpired:
        print(f"  {script} timed out", file=sys.stderr)
        return 1, ["timed out"]
    lines = [line for line in (proc.stdout or "").splitlines() if line.strip()]
    for line in lines:
        print(f"  {line}")
    for line in (proc.stderr or "").splitlines():
        if line.strip():
            print(f"  ! {line}", file=sys.stderr)
    return proc.returncode, lines


def main() -> int:
    parser = argparse.ArgumentParser(description="Find new funds and re-check every source page.")
    parser.add_argument("--skip-discovery", action="store_true", help="do not search for new funds")
    parser.add_argument("--skip-check", action="store_true", help="do not re-check the sources")
    parser.add_argument("--dry-run", action="store_true", help="search for new funds without adding them")
    parser.add_argument("--max-new", type=int, default=None, help="pass through to tools/discover.py")
    args = parser.parse_args()

    started = time.time()
    now = datetime.now(timezone.utc)
    today = date.today()
    notes: list[str] = []
    exit_code = 0

    if not args.skip_discovery:
        extra = ["--dry-run"] if args.dry_run else []
        if args.max_new is not None:
            extra += ["--max-new", str(args.max_new)]
        code, _ = run("discover.py", extra)
        if code != 0:
            notes.append("the new-fund search did not finish cleanly")
    if not args.skip_check and not args.dry_run:
        code, _ = run("check_sources.py")
        # Exit code 1 means some pages were blocked or unreachable — normal.
    elif args.dry_run:
        notes.append("dry run: nothing was added and the source check was skipped")

    latest = read_json(LATEST_FILE)
    discovery = read_json(DISCOVERY_FILE)
    candidates = discovery.get("candidates", {})
    run_stamp = now.isoformat(timespec="seconds")

    added = [
        record for record in candidates.values()
        if record.get("status") == "added" and record.get("last_checked") == discovery.get("last_run")
    ]
    queued = [
        {"name": record.get("name") or record.get("label", ""), "url": url,
         "reason": record.get("reason", ""), "seed": record.get("seed", ""),
         "first_seen": record.get("first_seen", "")}
        for url, record in candidates.items()
        if record.get("status") == "queued"
    ]
    queued.sort(key=lambda item: item.get("first_seen", ""), reverse=True)

    payload = {
        "run_at": run_stamp,
        "date": today.isoformat(),
        "duration_s": round(time.time() - started, 1),
        "added": [
            {"id": record.get("id", ""), "name": record.get("name", ""),
             "funder": record.get("funder", ""), "reason": record.get("reason", ""),
             "seed": record.get("seed", "")}
            for record in added
        ],
        "queued": queued[:QUEUED_IN_PAYLOAD],
        "queued_total": len(queued),
        "auto_total": discovery.get("added_total", 0),
        "check": {
            "total": latest.get("total"),
            "counts": latest.get("counts", {}),
            "report": latest.get("report", ""),
            "run_at": latest.get("run_at", ""),
            "verified": latest.get("verified", ""),
        },
        "notes": notes,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DAILY_FILE.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    state = read_json(STATE_FILE)
    history = list(state.get("daily_history", []))[-9:]
    history.append({"run_at": run_stamp, "added": [item["id"] for item in payload["added"]],
                    "queued": payload["queued_total"]})
    state["daily"] = {
        "last_run": run_stamp,
        "duration_s": payload["duration_s"],
        "added": [item["id"] for item in payload["added"]],
        "added_total": payload["auto_total"],
        "queued_total": payload["queued_total"],
        "report": payload["check"]["report"],
    }
    state["daily_history"] = history
    if STATE_FILE.exists() or state:
        STATE_FILE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

    print()
    print(f"Daily update finished in {payload['duration_s']}s")
    for item in payload["added"]:
        print(f"  new fund   {item['name']} ({item['funder']}) — {item['reason']}")
    if payload["queued_total"]:
        print(f"  {payload['queued_total']} candidate(s) waiting for a human in the review panel")
    counts = payload["check"]["counts"]
    if counts:
        print(f"  sources    {payload['check']['total']} checked · {counts.get('changed', 0)} changed · "
              f"{counts.get('blocked', 0)} blocked · {counts.get('unreachable', 0)} unreachable")
    print(f"  report     data-check/{payload['check']['report']}" if payload["check"]["report"] else "")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
