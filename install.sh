#!/usr/bin/env bash
set -euo pipefail
trap 'echo; echo "Installation interrompue." >&2; exit 130' INT TERM

REPO_URL="${REPO_URL:-https://github.com/jeromenatio/codex-mobile.git}"
APP_DIR="${APP_DIR:-/projects/codex-mobile}"
DEFAULT_WORKSPACE_ROOT="${DEFAULT_WORKSPACE_ROOT:-/projects}"
CODEX_MOBILE_INSTALL_ENV_DIR="${CODEX_MOBILE_INSTALL_ENV_DIR:-/etc/codex-mobile}"
CODEX_MOBILE_INSTALL_ENV_FILE="${CODEX_MOBILE_INSTALL_ENV_FILE:-${CODEX_MOBILE_INSTALL_ENV_DIR}/.env}"
SERVICE_INSTALL="${SERVICE_INSTALL:-yes}"
SERVICE_INSTALLED="no"
AUTH_TOKEN_VALUE=""
NODE_BIN=""
NPM_BIN=""
INSTALL_USER="${SUDO_USER:-$(id -un)}"
INSTALL_GROUP="$(id -gn "${INSTALL_USER}")"
INSTALL_HOME="$(getent passwd "${INSTALL_USER}" | cut -d: -f6)"

if ! command -v sudo >/dev/null 2>&1 && [[ "${EUID}" -ne 0 ]]; then
  echo "sudo est requis pour lancer l'installation." >&2
  exit 1
fi

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_owner() {
  if [[ "${INSTALL_USER}" == "root" ]]; then
    run_root "$@"
  elif [[ "${EUID}" -eq 0 ]]; then
    sudo -u "${INSTALL_USER}" -H "$@"
  else
    "$@"
  fi
}

prompt_yes_no() {
  local question="$1"
  local default_answer="${2:-y}"
  local reply

  while true; do
    if [[ "${default_answer}" == "y" ]]; then
      read -r -p "${question} [Y/n] " reply || reply=""
      reply="${reply:-y}"
    else
      read -r -p "${question} [y/N] " reply || reply=""
      reply="${reply:-n}"
    fi

    case "${reply}" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
    esac
  done
}

install_base_packages() {
  run_root apt update
  run_root apt install -y git curl ca-certificates gnupg openssl
}

install_node_if_needed() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm)"
    return
  fi

  if [[ "${EUID}" -eq 0 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  run_root apt install -y nodejs
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
}

install_codex_if_needed() {
  local node_bin="${NODE_BIN:-$(command -v node)}"
  local npm_bin="${NPM_BIN:-$(command -v npm)}"
  if command -v codex >/dev/null 2>&1; then
    return
  fi
  run_root "${node_bin}" "${npm_bin}" install -g @openai/codex
}

ensure_repo() {
  local app_parent
  app_parent="$(dirname "${APP_DIR}")"
  if ! run_root test -d "${app_parent}"; then
    run_root mkdir -p "${app_parent}"
    run_root chown "${INSTALL_USER}:${INSTALL_GROUP}" "${app_parent}"
  fi

  if [[ -d "${APP_DIR}/.git" ]]; then
    run_owner git -C "${APP_DIR}" fetch --all --prune
    run_owner git -C "${APP_DIR}" pull --ff-only
    return
  fi

  if [[ -d "${APP_DIR}" && ! -z "$(ls -A "${APP_DIR}" 2>/dev/null)" ]]; then
    echo "Le dossier ${APP_DIR} existe deja et n'est pas un depot git." >&2
    exit 1
  fi

  run_owner git clone "${REPO_URL}" "${APP_DIR}"
}

install_project_dependencies() {
  cd "${APP_DIR}"
  local node_bin="${NODE_BIN:-$(command -v node)}"
  local npm_bin="${NPM_BIN:-$(command -v npm)}"
  run_owner "${node_bin}" "${npm_bin}" install
}

prompt_workspace_root() {
  local reply
  if prompt_yes_no "Garder le dossier racine des workspaces par defaut (${DEFAULT_WORKSPACE_ROOT}) ?" "y"; then
    WORKSPACE_ROOT="${DEFAULT_WORKSPACE_ROOT}"
    return
  fi

  read -r -p "Nouveau dossier racine des workspaces: " reply
  reply="${reply:-${DEFAULT_WORKSPACE_ROOT}}"
  WORKSPACE_ROOT="${reply}"
}

generate_token() {
  openssl rand -hex 32
}

upsert_env_line() {
  local file="$1"
  local key="$2"
  local value="$3"
  local temp_file
  temp_file="$(mktemp)"

  if run_root test -f "${file}"; then
    run_root awk -v key="${key}" -v value="${value}" '
      BEGIN { replaced = 0 }
      index($0, key "=") == 1 {
        if (!replaced) {
          print key "=" value
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) {
          print key "=" value
        }
      }
    ' "${file}" > "${temp_file}"
  else
    printf '%s=%s\n' "${key}" "${value}" > "${temp_file}"
  fi

  run_root install -m 600 -o "${INSTALL_USER}" -g "${INSTALL_GROUP}" "${temp_file}" "${file}"
  rm -f "${temp_file}"
}

write_env_file() {
  run_root mkdir -p "${CODEX_MOBILE_INSTALL_ENV_DIR}"
  run_root chown "${INSTALL_USER}:${INSTALL_GROUP}" "${CODEX_MOBILE_INSTALL_ENV_DIR}"
  local auth_token existing_auth existing_github
  existing_auth=""
  auth_token=""
  AUTH_TOKEN_VALUE="${auth_token}"
  existing_github=""

  if run_root test -f "${CODEX_MOBILE_INSTALL_ENV_FILE}"; then
    existing_auth="$(
      run_root bash -lc "sed -n 's/^CODEX_MOBILE_AUTH_TOKEN=//p' '${CODEX_MOBILE_INSTALL_ENV_FILE}' | head -n 1"
    )"
    existing_github="$(
      run_root bash -lc "sed -n 's/^GITHUB_TOKEN=//p' '${CODEX_MOBILE_INSTALL_ENV_FILE}' | head -n 1"
    )"
  fi

  auth_token="${existing_auth:-$(generate_token)}"
  AUTH_TOKEN_VALUE="${auth_token}"

  run_root touch "${CODEX_MOBILE_INSTALL_ENV_FILE}"
  run_root chown "${INSTALL_USER}:${INSTALL_GROUP}" "${CODEX_MOBILE_INSTALL_ENV_FILE}"
  run_root chmod 600 "${CODEX_MOBILE_INSTALL_ENV_FILE}"
  upsert_env_line "${CODEX_MOBILE_INSTALL_ENV_FILE}" "CODEX_MOBILE_AUTH_TOKEN" "${auth_token}"
  upsert_env_line "${CODEX_MOBILE_INSTALL_ENV_FILE}" "GITHUB_TOKEN" "${existing_github}"
}

initialize_database() {
  local node_bin="${NODE_BIN:-$(command -v node)}"
  if [[ -z "${node_bin}" ]]; then
    echo "node introuvable pour l'initialisation de la base." >&2
    exit 1
  fi
  run_owner mkdir -p "${APP_DIR}/data"
  (
    cd "${APP_DIR}"
    run_owner mkdir -p "${WORKSPACE_ROOT}"
    run_owner env \
      CODEX_MOBILE_DATA_DIR="${APP_DIR}/data" \
      CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
      "${node_bin}" ./scripts/init-db.js
  )
}

ensure_codex_login() {
  if codex login status >/tmp/codex-mobile-login-status.txt 2>&1; then
    if grep -qi "Logged in" /tmp/codex-mobile-login-status.txt; then
      rm -f /tmp/codex-mobile-login-status.txt
      return
    fi
  fi

  rm -f /tmp/codex-mobile-login-status.txt
  local login_args=()
  if [[ -n "${SSH_CONNECTION:-}" && -z "${DISPLAY:-}" ]]; then
    login_args=(--device-auth)
  fi

  echo
  echo "Codex n'est pas connecte."
  if [[ "${#login_args[@]}" -gt 0 ]]; then
    echo "La commande 'codex login --device-auth' va etre lancee."
  else
    echo "La commande 'codex login' va etre lancee."
  fi

  if ! codex login "${login_args[@]}"; then
    echo "Connexion Codex interrompue ou echouee." >&2
    exit 1
  fi
}

install_service_if_requested() {
  if [[ "${SERVICE_INSTALL}" != "yes" ]]; then
    return
  fi

  if prompt_yes_no "Installer aussi les services systemd codex-mobile et codex-mobile-runtime ?" "y"; then
    (
      cd "${APP_DIR}"
      run_root chmod +x ./service.sh
      run_root env \
        SERVICE_QUIET=1 \
        RUN_USER="${INSTALL_USER}" \
        RUN_GROUP="${INSTALL_GROUP}" \
        RUN_HOME="${INSTALL_HOME}" \
        ./service.sh
    )
    SERVICE_INSTALLED="yes"
  fi
}

detect_server_ip() {
  local ip=""
  ip="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -n "${ip}" ]]; then
    printf '%s\n' "${ip}"
    return
  fi

  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s\n' "${ip}"
}

read_auth_token() {
  run_root bash -lc "sed -n 's/^CODEX_MOBILE_AUTH_TOKEN=//p' '${CODEX_MOBILE_INSTALL_ENV_FILE}' | head -n 1"
}

main() {
  echo "==> Installation de Codex Mobile"
  install_base_packages
  install_node_if_needed
  install_codex_if_needed
  ensure_repo
  install_project_dependencies
  prompt_workspace_root
  write_env_file
  initialize_database
  ensure_codex_login
  install_service_if_requested

  echo
  echo "========================================"
  echo "Installation terminee"
  echo "========================================"
  echo "Projet: ${APP_DIR}"
  echo "Root workspaces: ${WORKSPACE_ROOT}"
  echo "Env: ${CODEX_MOBILE_INSTALL_ENV_FILE}"
  echo "IP: $(detect_server_ip)"
  echo "Token d'acces: $(read_auth_token)"
  if [[ "${SERVICE_INSTALLED}" == "yes" ]]; then
    echo "Services: codex-mobile + codex-mobile-runtime"
  else
    echo "Services: non installes"
  fi
  echo "========================================"
  echo "Tu peux retrouver le token dans ${CODEX_MOBILE_INSTALL_ENV_FILE}"
  if [[ "${SERVICE_INSTALLED}" != "yes" ]]; then
    echo "Lancement manuel: cd ${APP_DIR} && npm start"
  fi
}

main "$@"
