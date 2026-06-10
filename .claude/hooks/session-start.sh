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

# graphify (/graphify skill) — best-effort: the skill in .claude/skills/graphify
# needs the `graphifyy` Python package on PATH at runtime. Prefer uv (isolated,
# PATH-managed), fall back to pipx then pip --user. A failure only means
# /graphify is unavailable this session; nothing else depends on it.
if command -v graphify >/dev/null 2>&1; then
  echo "[session-start] graphify already installed ($(graphify --version 2>/dev/null || echo present))."
elif command -v uv >/dev/null 2>&1 && uv tool install --quiet graphifyy; then
  echo "[session-start] graphify installed via uv."
elif command -v pipx >/dev/null 2>&1 && pipx install --quiet graphifyy; then
  echo "[session-start] graphify installed via pipx."
elif command -v pip3 >/dev/null 2>&1 && pip3 install --quiet --user graphifyy; then
  echo "[session-start] graphify installed via pip --user."
else
  echo "[session-start] WARN: graphify install failed; /graphify will be unavailable this session." >&2
fi
# notebooklm (/notebooklm skill) — best-effort: the skill in
# .claude/skills/notebooklm needs the notebooklm-py CLI on PATH. [browser]
# matches the skill's install guidance; auth still requires the user's Google
# cookies/login, so a session without credentials just gets a clear auth error.
if command -v notebooklm >/dev/null 2>&1; then
  echo "[session-start] notebooklm already installed ($(notebooklm --version 2>/dev/null || echo present))."
elif command -v uv >/dev/null 2>&1 && uv tool install --quiet "notebooklm-py[browser]"; then
  echo "[session-start] notebooklm installed via uv."
elif command -v pipx >/dev/null 2>&1 && pipx install --quiet "notebooklm-py[browser]"; then
  echo "[session-start] notebooklm installed via pipx."
elif command -v pip3 >/dev/null 2>&1 && pip3 install --quiet --user "notebooklm-py[browser]"; then
  echo "[session-start] notebooklm installed via pip --user."
else
  echo "[session-start] WARN: notebooklm install failed; /notebooklm will be unavailable this session." >&2
fi

# uv/pipx/pip --user all land CLIs in ~/.local/bin; make sure the session sees it.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && { [ -x "$HOME/.local/bin/graphify" ] || [ -x "$HOME/.local/bin/notebooklm" ]; }; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

echo "[session-start] Ready. Run 'npm test' for the full suite."
exit 0
