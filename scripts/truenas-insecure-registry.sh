#!/bin/sh
# ============================================================================
# TrueNAS Scale - persistently whitelist a self-hosted HTTP container
# registry (e.g. a LAN Gitea) as an INSECURE registry so Docker will pull
# from it.
#
# WHY: an HTTP (not HTTPS) LAN registry is refused by Docker unless it is
# listed in "insecure-registries" in /etc/docker/daemon.json. On TrueNAS
# Scale, manual edits to that file are WIPED on reboot / upgrade / some
# service restarts because TrueNAS regenerates it from its config database.
# Running this script at every boot makes the setting persistent.
#
# CONFIGURE: set the registry host:port below (or export REGISTRY before
# running). GHCR (ghcr.io) is HTTPS and needs none of this.
#
# INSTALL (one-time, in the TrueNAS UI):
#   1. System Settings -> Advanced -> Init/Shutdown Scripts -> Add
#   2. Description:  "Whitelist LAN registry as insecure"
#   3. Type:         "Command"  (not "Script")
#   4. Command/Path: paste the full path to this file on TrueNAS, e.g.
#                    /mnt/tank/scripts/truenas-insecure-registry.sh
#      OR paste the whole script body if your TrueNAS version allows inline.
#   5. When:         "Post Init"  (runs after every boot)
#   6. Save. Reboot once to confirm it applied:
#        docker info | grep -A6 "Insecure Registries"
#      should list your registry host:port
#
# You can also run this script manually once to apply the change immediately
# without a reboot (it will briefly restart Docker, i.e. restart all apps).
# ============================================================================

set -e

REGISTRY="${REGISTRY:-<registry-host>:<port>}"
FILE="/etc/docker/daemon.json"

# Ensure the file exists with valid JSON.
if [ ! -f "$FILE" ]; then
  echo '{}' > "$FILE"
fi

# Merge the insecure-registries entry idempotently (python3 ships with TrueNAS).
python3 - "$FILE" "$REGISTRY" <<'PY'
import json, sys
path, registry = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
regs = cfg.setdefault("insecure-registries", [])
if registry not in regs:
    regs.append(registry)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"[insecure-registry] ensured {registry} in {path}")
PY

# Apply: restart Docker so the new config takes effect.
# (At boot this is harmless; run manually only if you accept a brief restart
# of all Docker apps.)
if command -v systemctl >/dev/null 2>&1; then
  systemctl restart docker
  echo "[insecure-registry] docker restarted"
else
  echo "[insecure-registry] systemctl not found — please restart Docker manually"
fi
