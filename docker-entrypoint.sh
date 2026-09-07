#!/bin/sh
# Container entrypoint. Runs as root on typical TrueNAS/compose starts.
#
# The server itself runs as the unprivileged `node` user (uid 1000). Two
# host-mounted things root owns and node cannot read:
#   1. the SQLite data dir  -> chown it (writable volume)
#   2. the TLS cert/key     -> read-only bind mount, chown would fail, so we
#      copy them (as root) into an in-container dir owned by node with 600
#      permissions and point SSL_KEY/SSL_CERT at the copies. The private key
#      never leaves the container filesystem.
# Without this a root-owned 600 key.pem silently degrades the server to
# plain HTTP ("HTTPS=true but cert unreadable - falling back to plain HTTP").
set -e

DEFAULT_KEY=/app/certs/key.pem
DEFAULT_CERT=/app/certs/cert.pem
KEY_PATH="${SSL_KEY:-$DEFAULT_KEY}"
CERT_PATH="${SSL_CERT:-$DEFAULT_CERT}"

if [ "$(id -u)" = 0 ]; then
  chown -R node:node /app/data

  if [ -f "$KEY_PATH" ] && [ -f "$CERT_PATH" ]; then
    mkdir -p /run/chess-certs
    if cat "$CERT_PATH" > /run/chess-certs/cert.pem 2>/dev/null && \
       cat "$KEY_PATH" > /run/chess-certs/key.pem 2>/dev/null; then
      chmod 600 /run/chess-certs/*.pem
      chown -R node:node /run/chess-certs
      export SSL_KEY=/run/chess-certs/key.pem
      export SSL_CERT=/run/chess-certs/cert.pem
    else
      rm -rf /run/chess-certs
      echo "entrypoint: could not read $KEY_PATH / $CERT_PATH" >&2
    fi
  fi
fi

exec su-exec node bun server/index.ts
