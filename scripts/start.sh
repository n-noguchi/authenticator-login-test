#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s [--detach|-d]\n' "${0##*/}" >&2
}

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi

detach=false
if [ "$#" -eq 1 ]; then
  case "$1" in
    --detach|-d) detach=true ;;
    *)
      usage
      exit 2
      ;;
  esac
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
env_file="$root/.env"
tmp_env_file=

cleanup() {
  if [ -n "$tmp_env_file" ] && [ -e "$tmp_env_file" ]; then
    rm -f -- "$tmp_env_file"
  fi
}
trap cleanup EXIT HUP INT TERM

if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' 'Error: openssl is required to generate cryptographically secure local secrets.' >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Error: Docker Compose v2 is required (docker compose).' >&2
  exit 1
fi

random_secret() {
  openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '\r\n='
}

create_env_file() {
  umask 077
  tmp_env_file=$(mktemp "$root/.env.tmp.XXXXXXXX")

  {
    printf '%s\n' 'KEYCLOAK_ADMIN=admin'
    printf 'KEYCLOAK_ADMIN_PASSWORD=%s\n' "$(random_secret 32)"
    printf 'OIDC_CLIENT_SECRET=%s\n' "$(random_secret 32)"
    printf 'SESSION_SECRET=%s\n' "$(random_secret 48)"
    printf 'DEMO_USER_PASSWORD=%s\n' "$(random_secret 32)"
  } >"$tmp_env_file"

  # ln is atomic when the destination does not exist, so a concurrent creator
  # cannot be overwritten.  Do not fall back to mv: it would replace .env.
  if ! ln "$tmp_env_file" "$env_file"; then
    printf '%s\n' 'Error: .env was created concurrently; it was left unchanged. Please run this command again.' >&2
    exit 1
  fi
  rm -f -- "$tmp_env_file"
  tmp_env_file=
  printf '%s\n' 'Created .env with random local secrets.'
}

if [ ! -e "$env_file" ]; then
  create_env_file
fi

(
  cd "$root"
  # Disable Git Bash argument conversion so Compose receives its native paths.
  if [ "$detach" = true ]; then
    MSYS_NO_PATHCONV=1 docker compose --env-file .env config --quiet
    MSYS_NO_PATHCONV=1 docker compose --env-file .env up --build --detach
  else
    MSYS_NO_PATHCONV=1 docker compose --env-file .env config --quiet
    MSYS_NO_PATHCONV=1 docker compose --env-file .env up --build
  fi
)
