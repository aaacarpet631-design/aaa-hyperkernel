"""
backend-python/main.py — Google Cloud Function (Python 3.12) for AAA backup.

A faithful port of the Node backend. Same endpoints, same auth, same bucket
layout, same JSON response shapes — the frontend cannot tell the difference.

Endpoints (single function, routed by path):
  POST /backup           -> store a new versioned backup
  GET  /backup/latest    -> metadata about the most recent backup
  POST /restore/preview  -> return the latest backup payload for client-side preview

SECURITY (unchanged from Node version):
  - Owner-only via shared token: env APP_TOKEN, sent by browser as x-app-token.
  - No Google API key in the browser. The function's service account writes to GCS.
  - Backups are versioned (timestamped object names); never overwritten.

DEPLOY (from this folder):
  gcloud functions deploy aaa-backup-service \
    --gen2 --runtime=python312 --region=us-central1 \
    --source=. --entry-point=aaa_backup \
    --trigger-http --allow-unauthenticated \
    --set-env-vars=APP_TOKEN=YOUR-LONG-RANDOM-SECRET,BACKUP_BUCKET=YOUR-BUCKET,ALLOWED_ORIGIN=https://seiro-a54915.netlify.app

ARCHITECTURE NOTE: handle_request() is a pure function (no Flask, no GCS import
needed) so the routing/auth/backup logic is unit-testable anywhere. Storage is
injected: GcsStorage in production, MemoryStorage in tests. Same dual-backend
pattern as the frontend's IndexedDB/memory storage.
"""
import json
import os
import time
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Storage abstraction
# ---------------------------------------------------------------------------
class MemoryStorage:
    """In-memory bucket for tests. Mirrors the minimal GCS surface we use."""

    def __init__(self):
        self.objects = {}

    def exists(self, name):
        return name in self.objects

    def download(self, name):
        return self.objects[name]

    def save(self, name, data, content_type="application/json"):
        self.objects[name] = data


class GcsStorage:
    """Real Cloud Storage. Imported lazily so tests never need the package."""

    def __init__(self, bucket_name):
        from google.cloud import storage  # lazy import

        self._bucket = storage.Client().bucket(bucket_name)

    def exists(self, name):
        return self._bucket.blob(name).exists()

    def download(self, name):
        return self._bucket.blob(name).download_as_text()

    def save(self, name, data, content_type="application/json"):
        self._bucket.blob(name).upload_from_string(data, content_type=content_type)


# ---------------------------------------------------------------------------
# Pure request handler — no framework, fully testable
# ---------------------------------------------------------------------------
def cors_headers(allowed_origin):
    return {
        "Access-Control-Allow-Origin": allowed_origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-app-token",
    }


def handle_request(method, path, headers, body, env, store, now_ms=None):
    """
    Returns (status_code, response_dict_or_empty_string, headers_dict).
    `headers` keys are treated case-insensitively.
    `store` is MemoryStorage or GcsStorage (anything with exists/download/save).
    """
    allowed_origin = env.get("ALLOWED_ORIGIN", "*")
    h = cors_headers(allowed_origin)

    if method == "OPTIONS":
        return 204, "", h

    # owner-only auth (identical semantics to Node: missing APP_TOKEN rejects all)
    token = env.get("APP_TOKEN")
    header_token = next(
        (v for k, v in (headers or {}).items() if k.lower() == "x-app-token"), None
    )
    if not token or header_token != token:
        return 401, {"ok": False, "error": "UNAUTHORIZED"}, h

    bucket_name = env.get("BACKUP_BUCKET")
    if not bucket_name:
        return 500, {"ok": False, "error": "BACKUP_BUCKET_NOT_SET"}, h

    path = (path or "").rstrip("/")

    try:
        # POST /backup
        if method == "POST" and path.endswith("/backup"):
            payload = (body or {}).get("payload")
            if not payload:
                return 400, {"ok": False, "error": "MISSING_PAYLOAD"}, h
            version = now_ms if now_ms is not None else int(time.time() * 1000)
            created_at = (
                datetime.fromtimestamp(version / 1000, tz=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            backup_id = f"backup-{version}"
            object_name = f"backups/{backup_id}.json"
            store.save(
                object_name,
                json.dumps(
                    {
                        "backupId": backup_id,
                        "version": version,
                        "createdAt": created_at,
                        "payload": payload,
                    }
                ),
            )
            store.save(
                "backups/latest.json",
                json.dumps(
                    {
                        "backupId": backup_id,
                        "version": version,
                        "createdAt": created_at,
                        "objectName": object_name,
                    }
                ),
            )
            return (
                200,
                {"ok": True, "backupId": backup_id, "version": version, "createdAt": created_at},
                h,
            )

        # GET /backup/latest
        if method == "GET" and path.endswith("/backup/latest"):
            if not store.exists("backups/latest.json"):
                return 200, {"ok": True, "info": None}, h
            info = json.loads(store.download("backups/latest.json"))
            return 200, {"ok": True, "info": info}, h

        # POST /restore/preview
        if method == "POST" and path.endswith("/restore/preview"):
            if not store.exists("backups/latest.json"):
                return 200, {"ok": True, "backup": None}, h
            info = json.loads(store.download("backups/latest.json"))
            full = json.loads(store.download(info["objectName"]))
            return (
                200,
                {
                    "ok": True,
                    "backup": full["payload"],
                    "info": {
                        "backupId": full["backupId"],
                        "version": full["version"],
                        "createdAt": full["createdAt"],
                    },
                },
                h,
            )

        return 404, {"ok": False, "error": "UNKNOWN_ROUTE", "path": path}, h
    except Exception as err:  # noqa: BLE001 — match Node's catch-all behavior
        return 500, {"ok": False, "error": "SERVER_ERROR", "detail": str(err)}, h


# ---------------------------------------------------------------------------
# Google Cloud Functions adapter (thin; everything above is the real logic)
# ---------------------------------------------------------------------------
try:
    import functions_framework
    from flask import jsonify, make_response

    _store_cache = {}

    def _get_store():
        bucket = os.environ.get("BACKUP_BUCKET")
        if bucket and bucket not in _store_cache:
            _store_cache[bucket] = GcsStorage(bucket)
        return _store_cache.get(bucket)

    @functions_framework.http
    def aaa_backup(request):
        body = request.get_json(silent=True) or {}
        status, resp, hdrs = handle_request(
            method=request.method,
            path=request.path,
            headers=dict(request.headers),
            body=body,
            env=dict(os.environ),
            store=_get_store(),
        )
        out = make_response("" if resp == "" else jsonify(resp), status)
        for k, v in hdrs.items():
            out.headers[k] = v
        return out

except ImportError:
    # functions_framework not installed (e.g., running unit tests locally).
    # handle_request above remains fully usable.
    pass
