"""
test_main.py — stdlib-only tests for the Python backup backend.
Run: python3 -m unittest test_main -v
"""
import json
import unittest

from main import MemoryStorage, handle_request

ENV = {"APP_TOKEN": "secret-token", "BACKUP_BUCKET": "test-bucket", "ALLOWED_ORIGIN": "https://app.example"}
AUTH = {"x-app-token": "secret-token"}


def call(method, path, headers=None, body=None, env=None, store=None, now_ms=None):
    return handle_request(method, path, headers or {}, body, env or ENV, store or MemoryStorage(), now_ms)


class TestAuth(unittest.TestCase):
    def test_options_preflight_no_auth_needed(self):
        status, resp, hdrs = call("OPTIONS", "/backup")
        self.assertEqual(status, 204)
        self.assertEqual(hdrs["Access-Control-Allow-Origin"], "https://app.example")

    def test_missing_token_rejected(self):
        status, resp, _ = call("POST", "/backup", headers={})
        self.assertEqual(status, 401)
        self.assertEqual(resp["error"], "UNAUTHORIZED")

    def test_wrong_token_rejected(self):
        status, resp, _ = call("GET", "/backup/latest", headers={"x-app-token": "wrong"})
        self.assertEqual(status, 401)

    def test_header_case_insensitive(self):
        status, _, _ = call("GET", "/backup/latest", headers={"X-App-Token": "secret-token"})
        self.assertEqual(status, 200)

    def test_no_server_token_rejects_everything(self):
        env = dict(ENV)
        env.pop("APP_TOKEN")
        status, resp, _ = call("GET", "/backup/latest", headers=AUTH, env=env)
        self.assertEqual(status, 401)

    def test_missing_bucket_is_500(self):
        env = dict(ENV)
        env.pop("BACKUP_BUCKET")
        status, resp, _ = call("GET", "/backup/latest", headers=AUTH, env=env)
        self.assertEqual(status, 500)
        self.assertEqual(resp["error"], "BACKUP_BUCKET_NOT_SET")


class TestBackup(unittest.TestCase):
    def test_backup_requires_payload(self):
        status, resp, _ = call("POST", "/backup", headers=AUTH, body={})
        self.assertEqual(status, 400)
        self.assertEqual(resp["error"], "MISSING_PAYLOAD")

    def test_backup_stores_versioned_object_and_latest_pointer(self):
        store = MemoryStorage()
        status, resp, _ = call(
            "POST", "/backup", headers=AUTH, body={"payload": {"jobs": [1, 2]}}, store=store, now_ms=1700000000000
        )
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["backupId"], "backup-1700000000000")
        self.assertIn("backups/backup-1700000000000.json", store.objects)
        self.assertIn("backups/latest.json", store.objects)
        pointer = json.loads(store.objects["backups/latest.json"])
        self.assertEqual(pointer["objectName"], "backups/backup-1700000000000.json")

    def test_latest_none_when_empty(self):
        status, resp, _ = call("GET", "/backup/latest", headers=AUTH)
        self.assertEqual(status, 200)
        self.assertEqual(resp, {"ok": True, "info": None})

    def test_full_round_trip_backup_then_latest_then_preview(self):
        store = MemoryStorage()
        call("POST", "/backup", headers=AUTH, body={"payload": {"jobs": ["a"]}}, store=store, now_ms=1000)
        status, latest, _ = call("GET", "/backup/latest", headers=AUTH, store=store)
        self.assertEqual(latest["info"]["backupId"], "backup-1000")
        status, preview, _ = call("POST", "/restore/preview", headers=AUTH, store=store)
        self.assertEqual(status, 200)
        self.assertEqual(preview["backup"], {"jobs": ["a"]})
        self.assertEqual(preview["info"]["backupId"], "backup-1000")

    def test_second_backup_updates_latest(self):
        store = MemoryStorage()
        call("POST", "/backup", headers=AUTH, body={"payload": {"v": 1}}, store=store, now_ms=1000)
        call("POST", "/backup", headers=AUTH, body={"payload": {"v": 2}}, store=store, now_ms=2000)
        _, preview, _ = call("POST", "/restore/preview", headers=AUTH, store=store)
        self.assertEqual(preview["backup"], {"v": 2})
        # both versioned objects still exist — never overwritten
        self.assertIn("backups/backup-1000.json", store.objects)
        self.assertIn("backups/backup-2000.json", store.objects)

    def test_preview_none_when_empty(self):
        status, resp, _ = call("POST", "/restore/preview", headers=AUTH)
        self.assertEqual(resp, {"ok": True, "backup": None})

    def test_unknown_route_404(self):
        status, resp, _ = call("GET", "/nonsense", headers=AUTH)
        self.assertEqual(status, 404)
        self.assertEqual(resp["error"], "UNKNOWN_ROUTE")

    def test_trailing_slash_tolerated(self):
        status, resp, _ = call("GET", "/backup/latest/", headers=AUTH)
        self.assertEqual(status, 200)


class TestErrorHandling(unittest.TestCase):
    def test_storage_exception_returns_500_server_error(self):
        class ExplodingStore(MemoryStorage):
            def save(self, *a, **k):
                raise RuntimeError("disk on fire")

        status, resp, _ = call(
            "POST", "/backup", headers=AUTH, body={"payload": {"x": 1}}, store=ExplodingStore()
        )
        self.assertEqual(status, 500)
        self.assertEqual(resp["error"], "SERVER_ERROR")
        self.assertIn("disk on fire", resp["detail"])


if __name__ == "__main__":
    unittest.main()
