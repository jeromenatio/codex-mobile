#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-codex-mobile}"
RUNTIME_SERVICE_NAME="${RUNTIME_SERVICE_NAME:-codex-mobile-runtime}"
APP_DIR="${APP_DIR:-/projects/codex-mobile}"
RUN_USER="${RUN_USER:-}"
RUN_GROUP="${RUN_GROUP:-}"
RUN_HOME="${RUN_HOME:-}"
PORT="${PORT:-4180}"
SERVICE_QUIET="${SERVICE_QUIET:-0}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_FILE="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
RUNTIME_SERVICE_FILE="${SYSTEMD_DIR}/${RUNTIME_SERVICE_NAME}.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Ce script doit etre lance en root." >&2
  exit 1
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "node introuvable." >&2
  exit 1
fi

if [[ -z "${NPM_BIN}" || ! -x "${NPM_BIN}" ]]; then
  echo "npm introuvable." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}" ]]; then
  echo "Dossier projet introuvable: ${APP_DIR}" >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/server.js" ]]; then
  echo "server.js introuvable dans ${APP_DIR}" >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/runtime.js" ]]; then
  echo "runtime.js introuvable dans ${APP_DIR}" >&2
  exit 1
fi

if [[ -z "${RUN_USER}" ]]; then
  RUN_USER="$(stat -c '%U' "${APP_DIR}" 2>/dev/null || true)"
  RUN_USER="${RUN_USER:-${SUDO_USER:-root}}"
fi

if [[ -z "${RUN_GROUP}" ]]; then
  RUN_GROUP="$(id -gn "${RUN_USER}" 2>/dev/null || true)"
  RUN_GROUP="${RUN_GROUP:-root}"
fi

if [[ -z "${RUN_HOME}" ]]; then
  RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
fi

if [[ -z "${RUN_HOME}" ]]; then
  echo "Home introuvable pour ${RUN_USER}." >&2
  exit 1
fi

install -d -m 0755 "${SYSTEMD_DIR}"

cat > "${RUNTIME_SERVICE_FILE}" <<EOF
[Unit]
Description=Codex Mobile runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=HOME=${RUN_HOME}
Environment=CODEX_HOME=${RUN_HOME}/.codex
Environment=CODEX_MOBILE_ENV_FILE=/etc/codex-mobile/.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_BIN} ${APP_DIR}/runtime.js
Restart=always
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Codex Mobile server
After=network-online.target
Wants=network-online.target
Requires=${RUNTIME_SERVICE_NAME}.service
After=${RUNTIME_SERVICE_NAME}.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=HOME=${RUN_HOME}
Environment=CODEX_HOME=${RUN_HOME}/.codex
Environment=CODEX_MOBILE_ENV_FILE=/etc/codex-mobile/.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_BIN} ${NPM_BIN} start
Restart=always
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${RUNTIME_SERVICE_NAME}"
systemctl restart "${RUNTIME_SERVICE_NAME}"
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

if [[ "${SERVICE_QUIET}" != "1" ]]; then
  echo "Service runtime installe: ${RUNTIME_SERVICE_NAME}"
  echo "Fichier: ${RUNTIME_SERVICE_FILE}"
  echo "Service installe: ${SERVICE_NAME}"
  echo "Fichier: ${SERVICE_FILE}"
  echo "Statut:"
  systemctl --no-pager --full status "${RUNTIME_SERVICE_NAME}" || true
  systemctl --no-pager --full status "${SERVICE_NAME}" || true
fi
