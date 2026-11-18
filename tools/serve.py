#!/usr/bin/env python3
"""Serve the app locally, run the source checker and keep the list up to date.

    python3 tools/serve.py            # http://127.0.0.1:5173
    python3 tools/serve.py --port 8080
    python3 tools/serve.py --no-daily # serve and check, but never add funds

The static site works from any plain file server. The refresh button only runs
a live check when this helper is serving it: browsers cannot fetch funder sites
cross-origin, so the request has to go through a local process.

While it is running this process also owns the daily update: tools/daily.py is
started in the background when the last run is more than --daily-hours old, and
the app is told about the result through data-check/daily.json.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
CHECKER = ROOT / "tools" / "check_sources.py"
DAILY = ROOT / "tools" / "daily.py"
DATA_CHECK = ROOT / "data-check"
LATEST = DATA_CHECK / "latest.json"
DAILY_JSON = DATA_CHECK / "daily.json"
STATE = DATA_CHECK / "state.json"

_run_lock = threading.Lock()
_last_completed = 0.0  # time.time() of the last finished check
_daily = {"running": False, "started": 0.0, "finished": 0.0, "error": ""}
_daily_hours = 24.0
_daily_enabled = True


def read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def read_latest() -> dict | None:
    return read_json(LATEST)


def daily_status() -> dict:
    """What the app needs to know about the daily update."""
    saved = read_json(DAILY_JSON) or {}
    state = read_json(STATE) or {}
    last = (state.get("daily") or {}).get("last_run") or saved.get("run_at") or ""
    age_hours = None
    if last:
        try:
            age_hours = round(
                (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds() / 3600, 1
            )
        except ValueError:
            age_hours = None
    return {
        "enabled": _daily_enabled,
        "running": _daily["running"],
        "due": daily_due(),
        "last_run": last,
        "age_hours": age_hours,
        "error": _daily["error"],
        "result": saved or None,
    }


def daily_due() -> bool:
    if not _daily_enabled or _daily["running"]:
        return False
    state = read_json(STATE) or {}
    last = (state.get("daily") or {}).get("last_run") or ""
    if not last:
        return True
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds()
    except ValueError:
        return True
    return age >= _daily_hours * 3600


def run_daily(force: bool = False) -> bool:
    """Start tools/daily.py in the background. False when one is already running."""
    global _daily
    with _run_lock:
        if _daily["running"]:
            return False
        if not force and not daily_due():
            return False
        _daily = {"running": True, "started": time.time(), "finished": 0.0, "error": ""}

    def worker() -> None:
        global _daily
        log = DATA_CHECK / "daily.log"
        try:
            DATA_CHECK.mkdir(parents=True, exist_ok=True)
            with log.open("w", encoding="utf-8") as handle:
                handle.write(f"daily update started {datetime.now().isoformat(timespec='seconds')}\n")
                handle.flush()
                proc = subprocess.run(
                    [sys.executable, str(DAILY)],
                    cwd=str(ROOT), stdout=handle, stderr=subprocess.STDOUT, timeout=1800,
                )
            error = "" if proc.returncode == 0 else f"tools/daily.py exited with {proc.returncode}"
        except subprocess.TimeoutExpired:
            error = "the daily update timed out after 30 minutes"
        except Exception as exc:  # never kill the server because of the daily job
            error = f"{type(exc).__name__}: {exc}"
        _daily = {"running": False, "started": _daily["started"],
                  "finished": time.time(), "error": error}

    threading.Thread(target=worker, name="daily-update", daemon=True).start()
    return True


def daily_watcher(interval: float = 300.0) -> None:
    """Run the daily update whenever it falls due, for as long as we serve."""
    while True:
        time.sleep(interval)
        if daily_due():
            run_daily()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # keep the console quiet but useful
        sys.stderr.write("%s  %s\n" % (self.address_string(), fmt % args))

    def end_headers(self) -> None:
        # Local development: never let the browser cache a page or dataset that
        # was just edited, or the app keeps running yesterday's fund list. The
        # daily update rewrites js/data.js, so this matters on every reload.
        # Compare the path without its query string: "js/app.js?v=1" still ends
        # in .js.
        path = urlsplit(self.path).path
        if path.endswith((".html", ".js", ".css", ".json")) or path.endswith("/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True  # command-line clients
        port = self.server.server_port
        return origin in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/api/daily":
            self.send_json(daily_status())
            return
        if path == "/api/latest":
            payload = read_latest()
            if payload is None:
                self.send_json({"error": "no source check has run yet"}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json(payload)
            return
        if path == "/data-check/latest.json":
            payload = read_latest()
            if payload is None:
                self.send_json({"error": "no source check has run yet"}, HTTPStatus.NOT_FOUND)
            else:
                self.send_json(payload)
            return
        if path == "/api/health":
            self.send_json({"ok": True})
            return
        super().do_GET()

    def read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > 64 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def do_POST(self) -> None:
        global _last_completed
        path = self.path.split("?", 1)[0]
        if path not in {"/api/check", "/api/ack", "/api/daily"}:
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            return
        if not self.same_origin():
            self.send_json({"error": "cross-origin request refused"}, HTTPStatus.FORBIDDEN)
            return

        if path == "/api/daily":
            body = self.read_json_body() or {}
            force = bool(body.get("force"))
            if not _daily_enabled:
                self.send_json({"error": "the daily update is switched off for this server"},
                               HTTPStatus.CONFLICT)
                return
            if _daily["running"]:
                status = daily_status()
                status["already_running"] = True
                self.send_json(status)
                return
            started = run_daily(force=force)
            status = daily_status()
            status["started"] = started
            if not started:
                status["not_due"] = True
            self.send_json(status, HTTPStatus.ACCEPTED if started else HTTPStatus.OK)
            return

        if path == "/api/ack":
            if _daily["running"]:
                self.send_json(
                    {"error": "a daily update is running; try marking this reviewed in a moment"},
                    HTTPStatus.CONFLICT,
                )
                return
            body = self.read_json_body() or {}
            ids = body.get("ids")
            if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
                self.send_json({"error": "send {\"ids\": [\"fund-id\"]}"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                proc = subprocess.run(
                    [sys.executable, str(CHECKER), "--ack", *ids],
                    cwd=str(ROOT), capture_output=True, text=True, timeout=30,
                )
            except subprocess.TimeoutExpired:
                self.send_json({"error": "acknowledging timed out"}, HTTPStatus.GATEWAY_TIMEOUT)
                return
            payload = read_latest()
            if payload is None or proc.returncode != 0:
                detail = (proc.stdout + proc.stderr).strip()[-500:]
                self.send_json(
                    {"error": "could not mark the change as reviewed", "detail": detail},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            payload["acked"] = ids
            self.send_json(payload)
            return

        # One check at a time. A second tab waits for the run in flight instead
        # of starting a duplicate fetch of every funder page.
        # A daily update re-checks everything; do not make the page wait for it.
        if _daily["running"]:
            payload = read_latest() or {}
            payload["daily_running"] = True
            payload["daily"] = daily_status()
            payload["log"] = ["a daily update is running in the background"]
            self.send_json(payload)
            return

        started_waiting = time.time()
        with _run_lock:
            if _last_completed >= started_waiting:
                payload = read_latest()
                if payload is not None:
                    payload["coalesced"] = True
                    payload["daily"] = daily_status()
                    self.send_json(payload)
                    return
            try:
                proc = subprocess.run(
                    [sys.executable, str(CHECKER)],
                    cwd=str(ROOT),
                    capture_output=True,
                    text=True,
                    timeout=300,
                )
            except subprocess.TimeoutExpired:
                self.send_json({"error": "the source check timed out after 5 minutes"}, HTTPStatus.GATEWAY_TIMEOUT)
                return
            _last_completed = time.time()

            payload = read_latest()
            if payload is None:
                detail = (proc.stdout + proc.stderr).strip()[-1500:]
                self.send_json(
                    {"error": "the checker produced no result", "detail": detail},
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return

            payload["exit_code"] = proc.returncode
            payload["log"] = [line for line in (proc.stdout or "").strip().splitlines() if line][-4:]
            payload["daily"] = daily_status()
            self.send_json(payload)


def main() -> int:
    global _daily_hours, _daily_enabled
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=5173, help="port to listen on (default 5173)")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--daily-hours", type=float, default=24.0,
                        help="hours between daily updates (default 24)")
    parser.add_argument("--no-daily", action="store_true",
                        help="never search for new funds or run the daily update")
    args = parser.parse_args()

    _daily_hours = max(1.0, args.daily_hours)
    _daily_enabled = not args.no_daily

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{server.server_port}/"
    print(f"Serving {ROOT}")
    print(f"  {url}")
    print("  POST /api/check runs tools/check_sources.py and returns data-check/latest.json")
    print("  POST /api/ack   marks changes reviewed ({\"ids\": [...]})")
    if _daily_enabled:
        print(f"  POST /api/daily runs tools/daily.py — new funds plus a full check, every {_daily_hours:g}h")
        print("  daily updates run in the background; see data-check/daily.log")
        threading.Thread(target=daily_watcher, name="daily-watcher", daemon=True).start()
        if daily_due():
            print("  a daily update is due: starting it now")
            run_daily()
    else:
        print("  daily updates are switched off (--no-daily)")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
