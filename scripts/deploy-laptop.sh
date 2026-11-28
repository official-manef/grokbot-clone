#!/usr/bin/env bash
#
# Deploy the laptop build: back up the DB, fast-forward main, build, restart, verify.
#
# Why this file exists. `docs/CONTINUE.md` recorded the same half-done deploy four
# times: a `npm run build` with no restart (so the live process served an older build
# and answered `200 text/html` for an unknown `/api/*` path that the built code answers
# `404`), a restart with no build, and on 2026-11-28 a stop that nothing restarted, so
# `grok.rahmanef.com` answered `502` for 90 minutes. Each step is one line, and the
# failure is always that the steps are run apart. They run together here or not at all.
#
# The DB is copied before the restart on purpose: `npm run build` does not touch it, but
# a restart runs the migrations in `db.ts`, and a migration that goes wrong without a
# backup is not a deploy.
#
#   scripts/deploy-laptop.sh              # deploy
#   scripts/deploy-laptop.sh --dry-run    # print what would run, change nothing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${SERVICE:-grokbot-clone.service}"
PORT="${PORT:-8790}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/grokbot}"
DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

run() {
  if ((DRY)); then printf '  would run: %s\n' "$*"; else "$@"; fi
}

say() { printf '\n== %s\n' "$*"; }

cd "$ROOT"

say "1/5 database backup"
mkdir -p "$BACKUP_DIR"
if ((DRY)); then
  run echo "node -e better-sqlite3 .backup() -> $BACKUP_DIR/laptop-<ts>.db"
else
  # `.backup()` is the only safe copy of a live SQLite file: a plain `cp` can catch a
  # half-written WAL. Read the counts back rather than trusting the call.
  node -e '
    const Database = require("better-sqlite3");
    const path = require("node:path");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(process.argv[1], `laptop-${stamp}.db`);
    const db = new Database("data/grokbot.db", { readonly: true });
    db.backup(dest).then(() => {
      const t = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type=\u0027table\u0027").get().n;
      const b = db.prepare("SELECT COUNT(*) n FROM bots").get().n;
      console.log(`  backed up to ${dest} (${t} tables, ${b} bots)`);
    }).catch((e) => { console.error("  backup failed:", e.message); process.exit(1); });
  ' "$BACKUP_DIR"
fi

say "2/5 fast-forward to origin/main"
run git fetch --quiet origin
run git merge --ff-only origin/main

say "3/5 build"
run npm run build
if ((DRY)); then :; else
  # A build that produced no artifact is a restart onto nothing.
  [[ -f server/dist/index.js && -f web/dist/index.html ]] || {
    echo "  build produced no dist; refusing to restart" >&2; exit 1; }
fi

say "4/5 restart $SERVICE"
run systemctl --user restart "$SERVICE"

say "5/5 verify from the served socket, not the dist"
if ((DRY)); then
  run echo "curl the four answers below"
else
  # The service needs a moment to bind; poll instead of sleeping a guessed amount.
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
    sleep 1
  done
  ok=1
  check() { # label, path, expected status
    local got
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT$2" || true)
    if [[ "$got" == "$3" ]]; then printf '  ok   %-28s %s\n' "$1" "$got"
    else printf '  FAIL %-28s %s (expected %s)\n' "$1" "$got" "$3"; ok=0; fi
  }
  check "app shell"                "/"                         "200"
  check "health"                   "/api/health"               "200"
  check "removed google route"     "/api/auth/google/callback" "404"
  check "unknown /api path"        "/api/auth/nothing-here"    "404"
  ((ok)) || { echo "  a check above failed; the deploy is not done" >&2; exit 1; }
fi

say "done"
