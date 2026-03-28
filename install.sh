#!/usr/bin/env bash
set -euo pipefail
trap 'echo; echo "Installation interrompue." >&2; exit 130' INT TERM

REPO_URL="${REPO_URL:-https://github.com/jeromenatio/codex-mobile.git}"
APP_DIR="${APP_DIR:-/projects/codex-mobile}"
DEFAULT_WORKSPACE_ROOT="${DEFAULT_WORKSPACE_ROOT:-/projects}"
ENV_DIR="${ENV_DIR:-/etc/codex-mobile}"
ENV_FILE="${ENV_FILE:-${ENV_DIR}/.env}"
SERVICE_INSTALL="${SERVICE_INSTALL:-yes}"
AUTH_TOKEN_VALUE=""

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
    return
  fi

  if [[ "${EUID}" -eq 0 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  fi
  run_root apt install -y nodejs
}

install_codex_if_needed() {
  if command -v codex >/dev/null 2>&1; then
    return
  fi
  run_root npm install -g @openai/codex
}

ensure_repo() {
  run_root mkdir -p "$(dirname "${APP_DIR}")"

  if [[ -d "${APP_DIR}/.git" ]]; then
    git -C "${APP_DIR}" fetch --all --prune
    git -C "${APP_DIR}" pull --ff-only
    return
  fi

  if [[ -d "${APP_DIR}" && ! -z "$(ls -A "${APP_DIR}" 2>/dev/null)" ]]; then
    echo "Le dossier ${APP_DIR} existe deja et n'est pas un depot git." >&2
    exit 1
  fi

  git clone "${REPO_URL}" "${APP_DIR}"
}

install_project_dependencies() {
  cd "${APP_DIR}"
  npm install
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

write_env_file() {
  run_root mkdir -p "${ENV_DIR}"
  local auth_token existing_github
  auth_token="$(generate_token)"
  AUTH_TOKEN_VALUE="${auth_token}"
  existing_github=""

  if [[ -f "${ENV_FILE}" ]]; then
    existing_github="$(sed -n 's/^GITHUB_TOKEN=//p' "${ENV_FILE}" | head -n 1)"
  fi

  run_root touch "${ENV_FILE}"
  run_root chmod 600 "${ENV_FILE}"
  run_root bash -lc "cat > '${ENV_FILE}' <<'EOF'
CODEX_MOBILE_AUTH_TOKEN=${auth_token}
GITHUB_TOKEN=${existing_github}
EOF"
}

initialize_database() {
  run_root mkdir -p "${APP_DIR}/data"
  (
    cd "${APP_DIR}"
    run_root mkdir -p "${WORKSPACE_ROOT}"
    run_root env \
      CODEX_MOBILE_DATA_DIR="${APP_DIR}/data" \
      CODEX_MOBILE_DEFAULT_WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
      node ./scripts/init-db.js
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

  if prompt_yes_no "Installer aussi le service systemd codex-mobile ?" "y"; then
    (
      cd "${APP_DIR}"
      run_root chmod +x ./service.sh
      run_root ./service.sh
    )
  fi
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
  echo "Installation terminee."
  echo "Projet: ${APP_DIR}"
  echo "Root workspaces: ${WORKSPACE_ROOT}"
  echo "Env: ${ENV_FILE}"
  echo
  echo "Token d'acces:"
  echo "${AUTH_TOKEN_VALUE}"
  echo
  echo "Tu peux le retrouver plus tard dans ${ENV_FILE}"
  echo
  echo "Si tu n'as pas installe le service systemd, lance ensuite:"
  echo "cd ${APP_DIR} && npm start"
}

main "$@"
