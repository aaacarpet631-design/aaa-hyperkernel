# AAA Backup Backend — Python (Cloud Functions gen2)

Faithful port of the Node backend. Same endpoints, auth, bucket layout, and JSON
shapes — the frontend config does not change at all.

## Files
- main.py          — the function (pure testable core + GCS adapter)
- requirements.txt — functions-framework, google-cloud-storage
- test_main.py     — 15 stdlib unit tests (run: python3 -m unittest test_main -v)

## Deploy (from this folder)
gcloud functions deploy aaa-backup-service \
  --gen2 --runtime=python312 --region=us-central1 \
  --source=. --entry-point=aaa_backup \
  --trigger-http --allow-unauthenticated \
  --set-env-vars=APP_TOKEN=YOUR-NEW-LONG-RANDOM-SECRET,BACKUP_BUCKET=YOUR-BUCKET-NAME,ALLOWED_ORIGIN=https://seiro-a54915.netlify.app

NOTE: entry point is aaa_backup (snake_case), unlike the Node aaaBackup.
Deploying with the same function name (aaa-backup-service) REPLACES the Node
version — same URL, so the frontend needs no endpoint change.

## Verify after deploy
curl -H "x-app-token: YOUR-NEW-TOKEN" \
  https://us-central1-YOURPROJECT.cloudfunctions.net/aaa-backup-service/backup/latest
# expect: {"ok":true,"info":null}   (or info about your latest backup)

## What was tested vs not
- TESTED here (15 tests): auth (missing/wrong/case-insensitive token, no server
  token, missing bucket), backup write + versioned object + latest pointer,
  latest with/without backups, restore preview round-trip, second backup updates
  pointer without overwriting v1, trailing slashes, unknown routes, storage
  exceptions -> SERVER_ERROR.
- NOT tested here (verify with curl after deploy): real GCS writes and the
  Flask/functions-framework HTTP layer. The logic those layers call is the
  tested part.
