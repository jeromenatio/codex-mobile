#!/usr/bin/env bash
set -euo pipefail

INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/jeromenatio/codex-mobile/main/install.sh}"
UNIT_NAME="${UNIT_NAME:-codex-mobile-install}"
APP_DIR="${APP_DIR:-/projects/codex-mobile}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/projects}"
SERVICE_INSTALL="${SERVICE_INSTALL:-yes}"
INSTALL_USER="${INSTALL_USER:-${SUDO_USER:-$(id -un)}}"
INSTALL_GROUP="${INSTALL_GROUP:-$(id -gn "${INSTALL_USER}")}"
INSTALL_HOME="${INSTALL_HOME:-$(getent passwd "${INSTALL_USER}" | cut -d: -f6)}"

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

tmp_script="/tmp/${UNIT_NAME}.sh"
run_root rm -f "${tmp_script}"
run_root curl -fsSL "${INSTALL_SCRIPT_URL}" -o "${tmp_script}"
run_root chmod 755 "${tmp_script}"

run_root systemd-run \
  --unit="${UNIT_NAME}" \
  --collect \
  --service-type=exec \
  --same-dir \
  --property=StandardOutput=journal+console \
  --property=StandardError=journal+console \
  --setenv=APP_DIR="${APP_DIR}" \
  --setenv=DEFAULT_WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
  --setenv=CODEX_MOBILE_INSTALL_WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
  --setenv=CODEX_MOBILE_INSTALL_NONINTERACTIVE=1 \
  --setenv=CODEX_MOBILE_INSTALL_LOGIN_MODE=device \
  --setenv=CODEX_MOBILE_INSTALL_USER="${INSTALL_USER}" \
  --setenv=CODEX_MOBILE_INSTALL_GROUP="${INSTALL_GROUP}" \
  --setenv=CODEX_MOBILE_INSTALL_HOME="${INSTALL_HOME}" \
  --setenv=SERVICE_INSTALL="${SERVICE_INSTALL}" \
  /bin/bash "${tmp_script}"

cat <<EOF
Tache d'installation lancee dans systemd.

Unite:
  ${UNIT_NAME}

Suivre les logs:
  sudo journalctl -u ${UNIT_NAME} -f

Voir le dernier code Codex:
  sudo journalctl -u ${UNIT_NAME} -n 120 --no-pager | sed -n '/Open this link/,/Device codes/p'

Voir le statut:
  sudo systemctl status ${UNIT_NAME}
EOF
