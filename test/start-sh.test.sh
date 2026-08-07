#!/usr/bin/env bash

set -euo pipefail

repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$repo_root/scripts/start.sh"
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/start-sh-test.XXXXXXXX")
trap 'rm -rf -- "$tmp_root"' EXIT HUP INT TERM

assert() {
  if ! "$@"; then
    printf '%s\n' "assertion failed: $*" >&2
    exit 1
  fi
}

bash -n "$script"

if bash "$script" --invalid >"$tmp_root/invalid.out" 2>"$tmp_root/invalid.err"; then
  printf '%s\n' 'invalid argument unexpectedly succeeded' >&2
  exit 1
fi
assert grep -q 'Usage:' "$tmp_root/invalid.err"

mkdir -p "$tmp_root/repo/scripts" "$tmp_root/bin"
cp "$script" "$tmp_root/repo/scripts/start.sh"
cat >"$tmp_root/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
[ "$1" = compose ] || exit 1
shift
if [ "${1:-}" = version ]; then
  exit 0
fi
case " $* " in
  *' config --quiet '*) exit 0 ;;
  *' up --build '*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$tmp_root/bin/docker"

PATH="$tmp_root/bin:$PATH" bash "$tmp_root/repo/scripts/start.sh" -d >"$tmp_root/created.out"
env_path="$tmp_root/repo/.env"
assert test -f "$env_path"
assert test "$(awk -F= 'NF != 2 { exit 1 } END { print NR }' "$env_path")" = 5
assert test "$(cut -d= -f1 "$env_path" | tr '\n' ' ')" = 'KEYCLOAK_ADMIN KEYCLOAK_ADMIN_PASSWORD OIDC_CLIENT_SECRET SESSION_SECRET DEMO_USER_PASSWORD '
assert awk -F= '
  $1 == "KEYCLOAK_ADMIN" { ok = ($2 == "admin") }
  $1 != "KEYCLOAK_ADMIN" { ok = ok && ($2 ~ /^[A-Za-z0-9_-]+$/) }
  END { exit !ok }
' "$env_path"
while IFS= read -r line; do
  case "$line" in
    *=*) value=${line#*=}; assert test "$(grep -Fxc -- "$value" "$tmp_root/created.out")" = 0 ;;
  esac
done <"$env_path"

printf '%s\n' 'existing=must-not-change' >"$env_path"
PATH="$tmp_root/bin:$PATH" bash "$tmp_root/repo/scripts/start.sh" >"$tmp_root/existing.out"
assert cmp -s "$env_path" <(printf '%s\n' 'existing=must-not-change')

printf '%s\n' 'start.sh checks passed'
