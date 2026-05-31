#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs root dependencies so the app/functions runtime is ready and the
# container is warmed. The CORE test suite (`npm test`) is intentionally
# zero-dependency, so dep install is best-effort: a registry hiccup logs a
# warning but never blocks the session — matching this project's offline-first
# ethos. Idempotent and non-interactive; safe to run on every session.
set -uo pipefail

# Web sessions only; local runs already have their environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

echo "[session-start] Installing root dependencies (npm install)…"
if npm install --no-audit --no-fund; then
  echo "[session-start] Dependencies installed."
else
  echo "[session-start] WARN: npm install failed; core 'npm test' is zero-dependency and still runs." >&2
fi

echo "[session-start] Ready. Run 'npm test' for the full suite."
exit 0
