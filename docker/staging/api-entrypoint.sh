#!/bin/sh
set -eu
# Secret values never appear in argv or diagnostics.
if [ -n "${DATABASE_URL_FILE:-}" ]; then
  DATABASE_URL=$(cat "$DATABASE_URL_FILE")
  export DATABASE_URL
fi
if [ -n "${APP_ENCRYPTION_KEY_FILE:-}" ]; then
  APP_ENCRYPTION_KEY=$(cat "$APP_ENCRYPTION_KEY_FILE")
  export APP_ENCRYPTION_KEY
fi
exec "$@"
