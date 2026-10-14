import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, urlopen

from jsonschema import Draft202012Validator, FormatChecker
from playwright.sync_api import sync_playwright

CONFIG_PATH = Path(os.environ.get("STUDIO_BROWSER_CONFIG", "/config/config.json"))
STATE = Path("/state")
JOURNALS = Path("/journals")
STAGING = Path("/staging")
LOCK = threading.Lock()
SCHEMA = json.loads(Path("request.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
RECEIPT_LOCK = threading.Lock()
WRITES = 0

def config():
    return json.loads(CONFIG_PATH.read_text())

def atomic(path, value, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = path if exclusive else path.with_suffix("." + str(uuid.uuid4()) + ".tmp")
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
        json.dump(value, handle, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    if not exclusive:
        os.replace(destination, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def rejected(code, stage="preflight"):
    return {"version": 1, "status": "rejected", "noSideEffect": True, "error": {"code": code, "stage": stage, "retryable": False, "message": "The requested browser operation is blocked. Check session identity, account permission and fixture setup."}}

def unknown(value, code="SUBMISSION_UNKNOWN"):
    return {"version": 1, "status": "unknown", "attemptId": value["attemptId"], "error": {"code": code, "stage": "receipt", "retryable": False, "message": "Inspect the original attempt. Do not submit it again."}}

def webdriver(method, path, body=None):
    request = Request("http://browser:4444" + path, data=None if body is None else json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method=method)
    with urlopen(request, timeout=30) as response:
        return json.load(response)["value"]

def session():
    state_path = STATE / "session.json"
    if state_path.exists():
        saved = json.loads(state_path.read_text())
        try:
            webdriver("GET", "/session/" + saved["webdriverId"] + "/timeouts")
            return saved
        except Exception:
            if saved.get("handoff"):
                raise RuntimeError("MANUAL_HANDOFF_ACTIVE")
    settings = config()
    session_id = settings["sessionId"]
    created = webdriver("POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "chrome", "goog:chromeOptions": {"args": ["--user-data-dir=/home/seluser/profiles/" + session_id, "--disable-dev-shm-usage"]}}}})
    endpoint = created["capabilities"]["se:cdp"]
    parsed = urlsplit(endpoint)
    endpoint = "ws://browser:4444" + parsed.path
    saved = {"sessionId": session_id, "webdriverId": created["sessionId"], "endpoint": endpoint, "handoff": False}
    atomic(state_path, saved)
    return saved

def execute(value):
    VALIDATOR.validate(value)
    journal = JOURNALS / (value["attemptId"] + ".json")
    if value["operation"] == "publish" and journal.exists():
        try:
            record = json.loads(journal.read_text())
            if record.get("contentHash") != value["contentHash"] or record.get("accountId") != value["expectedAccountId"] or record.get("jobId") != value["jobId"]:
                return unknown(value, "ATTEMPT_ID_CONFLICT")
            return record.get("result", unknown(value))
        except Exception:
            return unknown(value, "JOURNAL_UNREADABLE")
    settings = config()
    deadline = datetime.fromisoformat(value["deadline"].replace("Z", "+00:00")).timestamp()
    if deadline <= time.time() or deadline > time.time()+35 or value["sessionId"] != settings["sessionId"]:
        return rejected("INVALID_SESSION_OR_DEADLINE")
    # No live page selector or write route is inferred from an unlicensed private adapter.
    if not settings.get("fixturesEnabled", False):
        return rejected("PLATFORM_PERMISSION_REQUIRED")
    if not LOCK.acquire(blocking=False):
        return rejected("SESSION_BUSY")
    journal = JOURNALS / (value["attemptId"] + ".json")
    dispatched = False
    try:
        saved = session()
        if saved["handoff"]:
            return rejected("MANUAL_HANDOFF_ACTIVE")
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(saved["endpoint"], timeout=20000)
            page = browser.contexts[0].pages[0]
            timeout = max(1, min(20000, int((deadline-time.time()) * 1000)))
            page.set_default_timeout(timeout)
            if value["operation"] in ("preflight", "publish"):
                scenario = settings.get("fixtureScenario", "normal")
                page.goto("http://browser-publisher:8916/fixture?scenario=" + scenario, timeout=timeout)
            actual = page.locator('meta[name="account-id"]').get_attribute("content")
            if actual != value["expectedAccountId"]:
                return rejected("ACCOUNT_MISMATCH")
            if value["operation"] == "preflight":
                return {"version": 1, "ready": True, "accountId": actual, "platform": value["platform"], "fixture": True}
            if value["operation"] == "collect_metrics":
                return {"views": 0, "likes": 2, "comments": None, "shares": None, "favorites": None, "clicks": None, "definition": "Isolated fixture counters", "adapterVersion": "fixture-v1", "source": "fixture"}
            if value["operation"] == "reconcile":
                if not journal.exists():
                    return unknown(value, "RECEIPT_NOT_FOUND")
                record = json.loads(journal.read_text())
                if record.get("contentHash") != value["contentHash"] or record.get("accountId") != actual or record.get("jobId") != value["jobId"]:
                    return unknown(value, "ATTEMPT_ID_CONFLICT")
                return record.get("result", unknown(value))
            if journal.exists():
                record = json.loads(journal.read_text())
                if record.get("contentHash") != value["contentHash"] or record.get("accountId") != actual or record.get("jobId") != value["jobId"]:
                    return unknown(value, "ATTEMPT_ID_CONFLICT")
                return record.get("result", unknown(value))
            if not value["assets"]:
                return rejected("REVIEWED_IMAGE_REQUIRED", "images")
            paths = []
            for asset in value["assets"]:
                candidate = STAGING / value["attemptId"] / asset["name"]
                if candidate.is_symlink() or candidate.parent.is_symlink():
                    return rejected("ASSET_INTEGRITY_MISMATCH", "images")
                path = candidate.resolve()
                if not path.is_relative_to(STAGING.resolve()) or path.is_symlink() or not path.is_file() or path.stat().st_size != asset["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
                    return rejected("ASSET_INTEGRITY_MISMATCH", "images")
                paths.append(str(path))
            page.locator("#title").fill(value["title"])
            page.locator("#body").fill(value["text"])
            page.locator("#symbols").fill(json.dumps(value["symbols"], separators=(",", ":")))
            page.locator("#images").set_input_files(paths)
            page.wait_for_function("count => document.querySelector('#image-ready').dataset.count === String(count)", arg=len(paths), timeout=timeout)
            page.wait_for_function("!document.querySelector('#submit').disabled", timeout=timeout)
            if page.locator('meta[name="account-id"]').get_attribute("content") != actual or time.time() >= deadline:
                return rejected("PREFLIGHT_CHANGED")
            for asset, path in zip(value["assets"], paths):
                if hashlib.sha256(Path(path).read_bytes()).hexdigest() != asset["sha256"]:
                    return rejected("ASSET_INTEGRITY_MISMATCH", "images")
            record = {"version": 1, "attemptId": value["attemptId"], "jobId": value["jobId"], "contentHash": value["contentHash"], "accountId": actual, "platform": value["platform"], "phase": "intent"}
            atomic(journal, record, exclusive=True)
            dispatched = True
            with page.expect_response(lambda reply: reply.url.endswith("/fixture/receipt"), timeout=timeout) as response:
                page.locator("#submit").click(no_wait_after=True)
            receipt = response.value.json()
            if not receipt.get("id") or receipt.get("accountId") != actual:
                result = unknown(value, "INVALID_RECEIPT")
            else:
                result = {"version": 1, "status": "accepted", "attemptId": value["attemptId"]}
                record["remoteId"] = receipt["id"]
            record["phase"] = "received"
            record["result"] = result
            atomic(journal, record)
            return result
    except Exception:
        return unknown(value) if dispatched else rejected("EDITOR_NOT_READY", "editor")
    finally:
        LOCK.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def respond(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        try:
            return not self.headers.get("Origin") and hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + config()["serviceKey"])
        except Exception:
            return False

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            self.respond(200, {"ready": CONFIG_PATH.is_file(), "liveEnabled": False})
        elif path == "/session/status" and self.authorized():
            saved = json.loads((STATE / "session.json").read_text()) if (STATE / "session.json").exists() else {}
            self.respond(200, {"sessionId": config()["sessionId"], "started": bool(saved), "handoff": saved.get("handoff", False), "fixture": config().get("fixturesEnabled", False)})
        elif path == "/fixture" and config().get("fixturesEnabled"):
            data = Path("fixture.html").read_bytes()
            self.send_response(200);self.send_header("Content-Type", "text/html; charset=utf-8");self.end_headers();self.wfile.write(data)
        elif path == "/fixture/writes" and self.authorized() and config().get("fixturesEnabled"):
            self.respond(200, {"writes": WRITES})
        else:
            self.respond(404, {"error": "Route unavailable"})

    def do_POST(self):
        global WRITES
        if self.path == "/fixture/receipt" and config().get("fixturesEnabled"):
            size = int(self.headers.get("Content-Length", "0"))
            if size > 1024:
                self.respond(413, {"error": "Too large"});return
            value = json.loads(self.rfile.read(size))
            with RECEIPT_LOCK:
                WRITES += 1
            if value.get("scenario") == "lost":
                time.sleep(25)
            self.respond(200, {"id": None if value.get("scenario") == "empty-id" else "456", "accountId": value.get("accountId")})
            return
        if not self.authorized():
            self.respond(403, {"error": "Service authorization required"});return
        size = int(self.headers.get("Content-Length", "0"))
        if size <= 0 or size > 256 * 1024:
            self.respond(413, {"error": "Bounded request required"});return
        try:
            value = json.loads(self.rfile.read(size))
            if self.path == "/request":
                self.respond(200, execute(value));return
            if self.path == "/session" and LOCK.acquire(blocking=False):
                try:
                    if set(value) != {"action", "sessionId"} or value["sessionId"] != config()["sessionId"] or value["action"] not in ("start", "handoff", "resume", "close"):
                        self.respond(400, {"error": "Invalid session control"});return
                    saved = session()
                    if value["action"] == "close":
                        webdriver("DELETE", "/session/" + saved["webdriverId"]);(STATE / "session.json").unlink(missing_ok=True)
                    elif value["action"] != "start":
                        saved["handoff"] = value["action"] == "handoff";atomic(STATE / "session.json", saved)
                    self.respond(200, {"sessionId": saved["sessionId"], "handoff": saved["handoff"], "closed": value["action"] == "close", "fixture": True})
                finally:
                    LOCK.release()
                return
            self.respond(409, {"error": "Session is busy"})
        except Exception:
            self.respond(400, {"error": "Invalid request or browser unavailable"})

if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700);JOURNALS.mkdir(parents=True, exist_ok=True, mode=0o700)
    ThreadingHTTPServer(("0.0.0.0", 8916), Handler).serve_forever()
