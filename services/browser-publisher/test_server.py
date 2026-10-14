"""Original executor regressions. Browser compatibility needs the separate smoke test."""
import json
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
import server

def packet():
    return {"version": 1, "operation": "publish", "platform": "xueqiu", "sessionId": str(uuid.uuid4()), "expectedAccountId": "123", "jobId": str(uuid.uuid4()), "attemptId": str(uuid.uuid4()), "contentHash": "a"*64, "revision": 1, "ownerToken": str(uuid.uuid4()), "deadline": (datetime.now(timezone.utc)+timedelta(seconds=30)).isoformat().replace("+00:00", "Z"), "title": "Original fixture", "text": "Source-backed internal fixture.", "symbols": [], "assets": []}

class JournalTests(unittest.TestCase):
    def test_intent_replay_cannot_create_another_browser_submission(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "JOURNALS", Path(folder)), patch.object(server, "session") as browser:
            value=packet();record={"jobId":value["jobId"],"attemptId":value["attemptId"],"accountId":"123","contentHash":value["contentHash"],"phase":"intent"}
            server.atomic(Path(folder)/(value["attemptId"]+".json"),record,exclusive=True)
            self.assertEqual(server.execute(value)["status"],"unknown")
            value["deadline"]="2000-01-01T00:00:00Z"
            self.assertEqual(server.execute(value)["status"],"unknown")
            value["contentHash"]="b"*64
            self.assertEqual(server.execute(value)["error"]["code"],"ATTEMPT_ID_CONFLICT")
            browser.assert_not_called()
            with self.assertRaises(FileExistsError): server.atomic(Path(folder)/(value["attemptId"]+".json"),record,exclusive=True)
    def test_accepted_receipt_replay_remains_acceptance(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server,"JOURNALS",Path(folder)), patch.object(server,"session") as browser:
            value=packet();result={"version":1,"status":"accepted","attemptId":value["attemptId"]}
            server.atomic(Path(folder)/(value["attemptId"]+".json"),{"jobId":value["jobId"],"accountId":"123","contentHash":value["contentHash"],"result":result})
            self.assertEqual(server.execute(value),result);browser.assert_not_called()
    def test_damaged_intent_remains_unknown(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(server,"JOURNALS",Path(folder)), patch.object(server,"session") as browser:
            value=packet();(Path(folder)/(value["attemptId"]+".json")).write_text("incomplete")
            self.assertEqual(server.execute(value)["error"]["code"],"JOURNAL_UNREADABLE");browser.assert_not_called()

class BoundaryTests(unittest.TestCase):
    def test_http_authentication_origin_schema_and_live_gate(self):
        value=packet();settings={"sessionId":value["sessionId"],"serviceKey":"fixture-test-key-not-a-secret", "fixturesEnabled":False}
        with tempfile.TemporaryDirectory() as folder, patch.object(server,"config",return_value=settings), patch.object(server,"JOURNALS",Path(folder)), patch.object(server,"session") as browser:
            http=ThreadingHTTPServer(("127.0.0.1",0),server.Handler);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            def send(body,auth=True,origin=False):
                headers={"Content-Type":"application/json"}
                if auth:headers["Authorization"]="Bearer "+settings["serviceKey"]
                if origin:headers["Origin"]="https://unrelated.example"
                return urlopen(Request("http://127.0.0.1:"+str(http.server_port)+"/request",json.dumps(body).encode(),headers,method="POST"),timeout=5)
            try:
                for authorized,origin in [(False,False),(True,True)]:
                    with self.assertRaises(HTTPError) as error:send(value,authorized,origin)
                    self.assertEqual(error.exception.code,403)
                with self.assertRaises(HTTPError) as error:send({**value,"version":2})
                self.assertEqual(error.exception.code,400)
                with send(value) as response:result=json.load(response)
                self.assertEqual(result["error"]["code"],"PLATFORM_PERMISSION_REQUIRED");self.assertTrue(result["noSideEffect"])
                browser.assert_not_called()
            finally:http.shutdown();http.server_close();thread.join()

if __name__=="__main__":unittest.main()
